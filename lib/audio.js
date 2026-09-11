/**
 * lib/audio.js —— 音频解码与格式化（无构建版，挂到 V2T.audio）。
 *
 * 只跑在 Offscreen Document 里（需要 AudioContext）。
 */
(function (root) {
  'use strict';

  var TARGET = (root.V2T && root.V2T.consts && root.V2T.consts.TARGET_SAMPLE_RATE) || 16000;

  /**
   * 解码任意浏览器能播放的音频/视频二进制，输出 16kHz 单声道 Float32Array。
   * Whisper 的特征提取器要求采样率固定 16000，所以这里统一重采样。
   */
  function makeDecodeContext() {
    var Ctor = root.OfflineAudioContext || root.webkitOfflineAudioContext;
    if (Ctor) {
      try {
        // (声道数=1, 长度=1, 采样率) —— 长度在 decodeAudioData 时会被实际数据覆盖
        return new Ctor(1, 1, TARGET);
      } catch (e) {
        /* 落到 AudioContext */
      }
    }
    var AC = root.AudioContext || root.webkitAudioContext;
    return new AC({ sampleRate: TARGET });
  }

  function downmixToMono(audioBuffer) {
    var channels = audioBuffer.numberOfChannels;
    if (channels === 1) {
      // getChannelData 返回的是内部缓冲的视图，拷贝一份避免被回收后内容异常
      return new Float32Array(audioBuffer.getChannelData(0));
    }
    var len = audioBuffer.length;
    var out = new Float32Array(len);
    for (var c = 0; c < channels; c++) {
      var data = audioBuffer.getChannelData(c);
      for (var i = 0; i < len; i++) out[i] += data[i];
    }
    for (var j = 0; j < len; j++) out[j] /= channels;
    return out;
  }

  /**
   * @param {ArrayBuffer} arrayBuffer 原始音频/视频字节（mp3/mp4/webm/wav/ogg…）
   * @returns {Promise<Float32Array>} 16kHz 单声道 PCM
   */
  function decodeToMono16k(arrayBuffer) {
    return Promise.resolve().then(function () {
      var ctx = makeDecodeContext();
      // decodeAudioData 会 detach 传入的 ArrayBuffer，所以传副本
      return ctx.decodeAudioData(arrayBuffer.slice(0)).then(downmixToMono).then(
        function (out) {
          if (ctx.close) ctx.close().catch(function () {});
          return out;
        },
        function (err) {
          if (ctx.close) ctx.close().catch(function () {});
          throw err;
        }
      );
    });
  }

  function audioDuration(mono16k) {
    return mono16k.length / TARGET;
  }

  function sliceAudio(mono16k, startSec, endSec) {
    var s = Math.max(0, Math.floor(startSec * TARGET));
    var e = Math.min(mono16k.length, Math.ceil(endSec * TARGET));
    return mono16k.slice(s, e);
  }

  /** 简单音量检测，用来提前拦掉「完全静音」的录音（比跑完模型才发现没有声音划算） */
  function isSilent(mono16k, threshold) {
    var th = threshold == null ? 0.0005 : threshold;
    var step = Math.max(1, Math.floor(mono16k.length / 20000));
    var peak = 0;
    for (var i = 0; i < mono16k.length; i += step) {
      var v = Math.abs(mono16k[i]);
      if (v > peak) peak = v;
    }
    return peak < th;
  }

  function formatTime(sec) {
    if (!isFinite(sec)) return '--:--';
    var s = Math.max(0, Math.floor(sec));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var ss = s % 60;
    function pad(n) {
      return String(n).length < 2 ? '0' + n : String(n);
    }
    return h > 0 ? h + ':' + pad(m) + ':' + pad(ss) : pad(m) + ':' + pad(ss);
  }

  root.V2T = root.V2T || {};
  root.V2T.audio = {
    decodeToMono16k: decodeToMono16k,
    audioDuration: audioDuration,
    sliceAudio: sliceAudio,
    isSilent: isSilent,
    formatTime: formatTime,
  };
})(typeof self !== 'undefined' ? self : this);
