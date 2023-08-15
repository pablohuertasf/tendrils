/**
 * A demo of the tendrils visuals - originally an interactive music video for
 * Max Cooper's "Trust".
 *
 * Disclaimer:
 * Several things done here (animation engine, audio analysis and response,
 * mouse/touch interaction, and some of the non-core shader stuff) are basically
 * learning exercises and experiments for me:
 *   - There are better approaches and libraries out there.
 *   - These were an interesting way for me to learn what might go into building
 *     these things.
 *   - There are some not very well researched, or combinations of
 *     odd/different approaches in here.
 * ...so, wouldn't take any of them as good ideas straight away.
 */

/* global Map */

import 'pepjs';
import glContext from 'gl-context';
import vkey from 'vkey';
import getUserMedia from 'getusermedia';
import analyser from 'web-audio-analyser';
import offset from 'mouse-event-offset';
import throttle from 'lodash/throttle';
import mapRange from 'range-fit';
import clamp from 'clamp';
import { mat3, vec2 } from 'gl-matrix';
import querystring from 'querystring';
import shader from 'gl-shader';
import prefixes from 'prefixes';

// import dat from 'dat-gui';
import dat from '../libs/dat.gui/build/dat.gui';

import { rootPath } from './utils/';
import redirect from './utils/protocol-redirect';

import Timer from './timer';

import { Tendrils, defaults, glSettings } from './';

import * as spawnPixels from './spawn/pixels';
import pixelsFrag from './spawn/pixels/index.frag';
import bestSampleFrag from './spawn/pixels/best-sample.frag';
import flowSampleFrag from './spawn/pixels/flow-sample.frag';
import dataSampleFrag from './spawn/pixels/data-sample.frag';

import spawnReset from './spawn/ball';
import GeometrySpawner from './spawn/geometry';

import AudioTrigger from './audio';
import AudioTexture from './audio/data-texture';
import { peak, meanWeight } from './analyse';

import FlowLines from './flow-line/multi';

import Player from './animate';

import Screen from './screen';
import Blend from './screen/blend';
import screenVert from './screen/index.vert';
import blurFrag from './screen/blur.frag';
import OpticalFlow from './optical-flow';

import { curry } from './fp/partial';
import reduce from './fp/reduce';
import map from './fp/map';
import each from './fp/each';

export default (canvas, options) => {
  if(redirect()) { return; }

  const settings = Object.assign(querystring.parse(location.search.slice(1)),
    options);

  const defaultSettings = defaults();
  const defaultState = defaultSettings.state;


  // Main init
  const gl = glContext(canvas, glSettings, render);
  const timer = { app: defaultSettings.timer, track: new Timer(0) };

  // Tendrils init
  const tendrils = new Tendrils(gl, { timer: timer.app, numBuffers: 1 });

  /**
   * Stateful but convenient way to set which buffer we spawn into.
   * Set the properties to the targets used by the corresponding spawn
   * functions: to a buffer (e.g: `tedrils.targets`) to spawn into it; or
   * `undefined` to spawn into the default (the next particle step buffer).
   *
   * @type {Object.<(FBO|undefined)>}
   */
  const spawnTargets = {};

  const resetSpawner = spawnReset(gl);

  resetSpawner.shader.bind();


  // Some convenient shorthands

  const respawn = (buffer = spawnTargets.respawn) =>
    resetSpawner.spawn(tendrils, buffer);

  const reset = () => tendrils.reset();

  const restart = () => {
    tendrils.clear();
    respawn();
    respawn(tendrils.targets);
    timer.app.time = 0;
  };

  const clear = () => tendrils.clear();
  const clearView = () => tendrils.clearView();
  const clearFlow = () => tendrils.clearFlow();

  const state = tendrils.state;

  const appSettings = {
    trackURL: (((''+settings.track).match(/(false|undefined)/gi))? ''
      : settings.track),

    useMedia: (''+settings.use_media !== 'false'),
    useCamera: (''+settings.use_camera !== 'false'),
    useMic: (''+settings.use_mic !== 'false'),

    flipVideoX: (''+settings.flip_video_x === 'true'),
    flipVideoY: (''+settings.flip_video_y === 'true'),

    loopTime: Math.max(0,
      parseInt((settings.loop_time || 10*60*10e2), 10) || 0),

    loopPresets: Math.max(0,
      parseInt((settings.loop_presets || 0), 10) || 0),

    pointerFlow: (''+settings.pointer_flow !== 'false'),
    staticImage: ((settings.static_image)? settings.static_image
      : 'https://cdn.glitch.global/5a1020a0-a6aa-4bd7-9c92-f7f1c200d085/o-s-m%2Bw.png?v=1691763188287')
  };

  Object.assign(timer.app,
    { end: appSettings.loopTime, loop: !!appSettings.loopTime });

  if(''+settings.cursor === 'false') { canvas.classList.add('epok-no-cursor'); }

  // Audio init

  const audioDefaults = {
    audible: (''+settings.mute !== 'true'),

    track: parseFloat((settings.track_in || 1), 10),
    trackFlowAt: 0.2, // 1.15,
    trackFastAt: 0.03, // 0.12,
    trackFormAt: 0.015, // 0.06,
    trackSampleAt: 0.035, // 0.12,
    trackCamAt: 0.002, // 0.008,
    trackSpawnAt: 0.045, // 0.18,

    mic: parseFloat((settings.mic_in || 1), 10),
    ...((''+settings.mic_track !== 'true')?
        {
          micFlowAt: 0.5,
          micFastAt: 0.8,
          micFormAt: 0.5,
          micSampleAt: 0.74,
          micCamAt: 0.06,
          micSpawnAt: 0.09
        }
      : {
          // Should be the same as track above... but the input values seem to
          // differ when audio's rerouted to mic input.
          // mic: parseFloat((settings.mic_in || 0.02), 10),
          micFlowAt: 0.2, // 1.15,
          micFastAt: 0.03, // 0.12,
          micFormAt: 0.015, // 0.06,
          micSampleAt: 0.035, // 0.12,
          micCamAt: 0.002, // 0.008,
          micSpawnAt: 0.045 // 0.18
        })
  };

  // Track

  const track = Object.assign(new Audio(),
    { crossOrigin: 'anonymous', className: 'track' });

  const audioContext = new (self.AudioContext || self.webkitAudioContext)();

  // Deal with Chrome's need for user interaction before playing audio...
  // @see https://developers.google.com/web/updates/2017/09/autoplay-policy-changes#webaudio
  canvas.addEventListener('click', () =>
    (audioContext.state === 'suspended' &&
      audioContext.resume().then(() => console.log('Restarted audio'))));

  // Track control setup

  const trackControls = document.querySelector('.epok-audio-controls');

  const trackControl = (trackControls && {
    els: {
      main: trackControls,
      toggle: trackControls.querySelector('.epok-play-toggle'),
      progress: trackControls.querySelector('.epok-progress'),
      current: trackControls.querySelector('.epok-current'),
      total: trackControls.querySelector('.epok-total')
    },
    times: {
      current: new Date(0),
      total: new Date(0)
    },
    timeFormat: {
      second: 'numeric'
    },
    seeking: false,

    trackTimeChanged() {
      trackControl.els.progress.max = track.duration;

      const total = track.duration*1e3;

      trackControl.times.total.setTime(total);

      trackControl.timeFormat.minute = ((total >= 60e3)?
        'numeric' : undefined);

      trackControl.timeFormat.hour = ((total >= 60*60e3)?
        'numeric' : undefined);

      trackControl.els.current.innerText = 0;

      trackControl.els.total.innerText = trackControl.times.total
        .toLocaleTimeString('en-gb', trackControl.timeFormat);
    },
    tick(time, paused) {
      trackControl.times.current.setTime(time);

      trackControl.els.current.innerText = trackControl.times.current
        .toLocaleTimeString('en-gb', trackControl.timeFormat);

      if(!trackControl.seeking) {
        trackControl.els.progress.value = time*0.001;
      }

      trackControl.els.toggle.checked = !paused;
    }
  });

  if(trackControl) {
    trackControl.els.main.parentElement.removeChild(trackControl.els.main);
    trackControl.els.main.appendChild(track);
    trackControl.els.main.classList.add('epok-show');

    track.addEventListener('durationchange', trackControl.trackTimeChanged);

    trackControl.els.toggle.addEventListener('change',
      () => ((trackControl.els.toggle.checked)?
        track.play() : track.pause()));

    trackControl.els.progress.addEventListener('pointerdown',
      () => trackControl.seeking = true);

    trackControl.els.progress.addEventListener('change', () => {
      if(trackControl.seeking) {
        track.currentTime = trackControl.els.progress.value;
        trackControl.seeking = false;
      }
    });
  }


  // Analyser setup

  // Convenience to mix in some things on top of the standard analyser setup.
  function makeAnalyser(...rest) {
    const a = analyser(...rest);
    const gain = a.gain = a.ctx.createGain();
    const out = (a.splitter || a.analyser);

    a.source.disconnect();
    a.source.connect(gain).connect(out);

    return a;
  }

  const audioState = { ...audioDefaults };

  // @todo Stereo - creates 2 separate analysers for each channel.
  // @todo Delay node to compensate for wait in analysing values?

  const trackAnalyser = makeAnalyser(track, audioContext, { audible: audioState.audible });

  trackAnalyser.analyser.fftSize = Math.pow(2, 8);

  const trackTrigger = new AudioTrigger(trackAnalyser, 4);

  // Mic refs
  let micAnalyser;
  let micTrigger;

  // Track setup

  const setupTrack = (src, el = canvas.parentElement, onWindow = false) => {
    if(track.src !== src) {
      track.src = src;
      track.currentTime = 0;
    }

    if(trackControl) {
      const main = trackControl.els.main;

      if(main.parentElement !== el) {
        el.appendChild(main);
      }

      main.classList[((onWindow)? 'add' : 'remove')]('epok-on-window');
    }

    return track;
  };

  const setupTrackURL = (trackURL = appSettings.trackURL) =>
    trackURL && setupTrack(trackURL, canvas.parentElement, true);

  setupTrackURL();

  // Flow inputs

  const flowInputs = new FlowLines(gl);

  const pointerFlow = (e) => {
    if(appSettings.pointerFlow) {
      /**
       * @todo Passing a `vec2` doesn't work - TypedArrays fail the test
       *     `offset` uses.
       */
      // const pos = offset(e, canvas, vec2.create());
      const pos = offset(e, canvas);

      pos[0] = mapRange(pos[0], 0, tendrils.viewRes[0], -1, 1);
      pos[1] = mapRange(pos[1], 0, tendrils.viewRes[1], 1, -1);

      flowInputs.get(e.pointerId).add(timer.app.time, pos);

      e.preventDefault();
    }
  };

  canvas.addEventListener('pointermove', pointerFlow, false);


  // Spwan feedback loop from flow
  /**
   * @todo The aspect ratio might be wrong here - always seems to converge on
   *     horizontal/vertical lines, like it were stretched.
   */

  const flowPixelSpawner = new spawnPixels.PixelSpawner(gl, {
      shader: [spawnPixels.defaults().shader[0], flowSampleFrag],
      buffer: tendrils.flow
    });

  const flowPixelScales = {
    'normal': [1, -1],
    // This flips the lookup, which is interesting (reflection)
    'mirror x': [-1, -1],
    'mirror y': [1, 1],
    'mirror xy': [-1, 1],
  };

  const flowPixelDefaults = { scale: 'normal' };
  const flowPixelState = { ...flowPixelDefaults };

  function spawnFlow(buffer = spawnTargets.spawnFlow) {
    vec2.div(flowPixelSpawner.spawnSize,
      flowPixelScales[flowPixelState.scale], tendrils.viewSize);

    flowPixelSpawner.spawn(tendrils, undefined, buffer);
  }

  // Spawn on fastest particles.

  const simplePixelSpawner = new spawnPixels.PixelSpawner(gl, {
    shader: [spawnPixels.defaults().shader[0], dataSampleFrag],
    buffer: null
  });

  function spawnFastest(buffer = spawnTargets.spawnFastest) {
    simplePixelSpawner.buffer = tendrils.particles.buffers[0];
    simplePixelSpawner.spawnSize = tendrils.particles.shape;
    simplePixelSpawner.spawn(tendrils, undefined, buffer);
  }

  // Respawn from geometry (platonic forms)

  const geometrySpawner = new GeometrySpawner(gl,
    { speed: 0.005, bias: 100/0.005 });

  const spawnForm = (buffer = spawnTargets.spawnForm) =>
    geometrySpawner.shuffle().spawn(tendrils, undefined, buffer);

  // Media - cam and mic

  const imageShaders = {
    direct: shader(gl, spawnPixels.defaults().shader[0], pixelsFrag),
    sample: shader(gl, spawnPixels.defaults().shader[0], bestSampleFrag)
  };

  const imageSpawner = new spawnPixels.PixelSpawner(gl, { shader: null });

  mat3.scale(imageSpawner.spawnMatrix,
    mat3.identity(imageSpawner.spawnMatrix), [-1, 1]);

  const rasterShape = { image: [0, 0], video: [0, 0] };

  const video = Object.assign(document.createElement('video'),
    { controls: true, muted: true, autoplay: false });

  const videoCanvas = document.createElement('canvas');
  const videoContext = videoCanvas.getContext('2d');

  video.addEventListener('canplay', () => {
    rasterShape.video = [video.videoWidth, video.videoHeight];
    video.play();
  });

  const image = new Image();

  image.src = appSettings.staticImage;

  image.addEventListener('load',
    () => rasterShape.image = [image.width, image.height]);

  function spawnRaster(shader, speed, buffer) {
    imageSpawner.shader = shader;
    imageSpawner.speed = speed;

    let shape = rasterShape.image;
    let raster = image;

    if(appSettings.useMedia && appSettings.useCamera && video) {
      shape = rasterShape.video;
      raster = videoCanvas;
    }

    if(Math.min(...shape) > 0) {
      imageSpawner.buffer.shape = tendrils.colorMap.shape = shape;

      imageSpawner.setPixels(raster);
      imageSpawner.spawn(tendrils, undefined, buffer);
    }
    else {
      console.warn('`spawnRaster`: image not ready.', raster);
    }
  }

  const spawnImage = (buffer = spawnTargets.spawnImage) =>
    spawnRaster(imageShaders.direct, 0.3, buffer);

  const spawnSamples = (buffer = spawnTargets.spawnSamples) =>
    spawnRaster(imageShaders.sample, 1, buffer);

  function spawnImageTargets() {
    spawnTargets.spawnImage = tendrils.targets;
    spawnImage(tendrils.targets);
    spawnImage(null);
  }

  // Optical flow

  const opticalFlow = new OpticalFlow(gl, undefined, {
    speed: parseFloat(settings.optical_speed || 0.08, 10),
    offset: 0.1,
    scaleUV: [-1, -1]
  });

  const opticalFlowState = {
    speed: opticalFlow.uniforms.speed,
    lambda: opticalFlow.uniforms.lambda,
    offset: opticalFlow.uniforms.offset
  };

  const opticalFlowDefaults = { ...opticalFlowState };

  // Color map blending

  const trackTexture = new AudioTexture(gl,
    trackAnalyser.analyser.frequencyBinCount);

  // We'll swap in the mic texture if/when it's created.
  let micTexture = null;

  const blendMap = {
    mic: trackTexture.texture,
    track: trackTexture.texture,
    video: opticalFlow.buffers[0]
  };

  const blendKeys = Object.keys(blendMap);

  const blend = new Blend(gl,
    { views: Object.values(blendMap), alphas: [0.1, 0.3, 0.8] });

  // Media access

  let mediaStream;

  function getMedia() {
    appSettings.useMedia = true;

    getUserMedia({ video: appSettings.useCamera, audio: appSettings.useMic },
      (e, stream) => {
        if(e) {
          console.warn(e);
        }
        else if(appSettings.useCamera || appSettings.useMic) {
          mediaStream = stream;

          if(appSettings.useCamera) {
            (('srcObject' in video)? (video.srcObject = stream)
              : (video.src = self.URL.createObjectURL(stream)));
          }

          if(appSettings.useMic) {
            micAnalyser = (micAnalyser ||
              makeAnalyser(stream, audioContext, { audible: false }));

            micAnalyser.analyser.fftSize = Math.pow(2, 8);
            micTrigger = (micTrigger || new AudioTrigger(micAnalyser, 4));

            micTexture = new AudioTexture(gl,
              micAnalyser.analyser.frequencyBinCount);

            blend.views[blendKeys.indexOf('mic')] = micTexture.texture;
          }
        }
      });
  }

  function stopMedia(stream = mediaStream) {
    appSettings.useMedia = false;
    stream && each((track) => track.stop(), stream.getTracks());
    micTexture = null;
    blend.views[blendKeys.indexOf('mic')] = trackTexture.texture;
  }

  const toggleMedia = (toggle = appSettings.useMedia) =>
    ((toggle)? getMedia : stopMedia)();

  appSettings.useMedia && getMedia();

  // Audio `react` and `test` function pairs - for `AudioTrigger.fire`
  /**
   * @todo Separate these concerns, caching different kinds of audio response
   *     (frequencies, rate); while the callback is defined separately.
   *
   * @todo Move this cache stuff to `analyse` or a dedicated module, to handle
   *     more subtle cases (like one analysis of data being used by others)?
   *     Might need a cache per analysis function (WeakMap keyed on the
   *     array of data), or explicit string keys.
   */

  const audioCache = new Map();

  const audioFirer = (threshold, key, test) => (trigger) => {
    const t = threshold();

    if(!t) { return t; }

    const cached = audioCache.get(key);

    if(cached) { return cached; }

    const value = test(trigger, t);

    audioCache.set(key, value);

    return value;
  };

  const trackFires = [
    [
      () => spawnFlow(),
      audioFirer(() => audioState.trackFlowAt,
        'trackFlowAt | Low end - velocity | meanWeight(track, 1, 0.25)',
        (trigger, t) => meanWeight(trigger.dataOrder(1), 0.25) > t)
    ],
    [
      () => spawnFastest(),
      audioFirer(() => audioState.trackFastAt,
        'trackFastAt | High end - acceleration | meanWeight(track, 2, 0.8)',
        (trigger, t) => meanWeight(trigger.dataOrder(2), 0.8) > t)
    ],
    [
      () => spawnForm(),
      audioFirer(() => audioState.trackFormAt,
        'trackFormAt | Sudden click/hit - force/attack | abs(peak(track, 3))',
        (trigger, t) => Math.abs(peak(trigger.dataOrder(3))) > t)
    ],
    [
      () => spawnSamples(),
      audioFirer(() => audioState.trackSampleAt,
        'trackSampleAt | Low end - acceleration | meanWeight(track, 2, 0.25)',
        (trigger, t) => meanWeight(trigger.dataOrder(2), 0.25) > t)
    ],
    [
      () => spawnImageTargets(),
      audioFirer(() => audioState.trackCamAt,
        'trackCamAt | Mid - force/attack | meanWeight(track, 3, 0.5)',
        (trigger, t) => meanWeight(trigger.dataOrder(3), 0.5) > t)
    ],
    [
      () => restart(),
      audioFirer(() => audioState.trackSpawnAt,
        'trackSpawnAt | Low end - acceleration | meanWeight(track, 3, 0.25)',
        (trigger, t) => meanWeight(trigger.dataOrder(2), 0.25) > t)
    ]
  ];

  const micFires = ((''+settings.mic_track === 'true')?
      [
        [
          () => spawnFlow(),
          audioFirer(() => audioState.micFlowAt,
            'micFlowAt | Low end - velocity | meanWeight(mic, 1, 0.25)',
            (trigger, t) => meanWeight(trigger.dataOrder(1), 0.25) > t)
        ],
        [
          () => spawnFastest(),
          audioFirer(() => audioState.micFastAt,
            'micFastAt | High end - acceleration | meanWeight(mic, 2, 0.8)',
            (trigger, t) => meanWeight(trigger.dataOrder(2), 0.8) > t)
        ],
        [
          () => spawnForm(),
          audioFirer(() => audioState.micFormAt,
            'micFormAt | Sudden click/hit - force/attack | abs(peak(mic, 3))',
            (trigger, t) => Math.abs(peak(trigger.dataOrder(3))) > t)
        ],
        [
          () => spawnSamples(),
          audioFirer(() => audioState.micSampleAt,
            'micSampleAt | Low end - acceleration | meanWeight(mic, 2, 0.25)',
            (trigger, t) => meanWeight(trigger.dataOrder(2), 0.25) > t)
        ],
        [
          () => spawnImageTargets(),
          audioFirer(() => audioState.micCamAt,
            'micCamAt | Mid - force/attack | meanWeight(mic, 3, 0.5)',
            (trigger, t) => meanWeight(trigger.dataOrder(3), 0.5) > t)
        ],
        [
          () => restart(),
          audioFirer(() => audioState.micSpawnAt,
            'micSpawnAt | Low end - acceleration | meanWeight(mic, 3, 0.25)',
            (trigger, t) => meanWeight(trigger.dataOrder(2), 0.25) > t)
        ]
      ]
    : [
        [
          () => spawnFlow(),
          audioFirer(() => audioState.micFlowAt,
            'micFlowAt | Low end - velocity | meanWeight(mic, 1, 0.3)',
            (trigger, t) => meanWeight(trigger.dataOrder(1), 0.3) > t)
        ],
        [
          () => spawnFastest(),
          audioFirer(() => audioState.micFastAt,
            'micFastAt | High end - velocity | meanWeight(mic, 1, 0.7)',
            (trigger, t) => meanWeight(trigger.dataOrder(1), 0.7) > t)
        ],
        [
          () => spawnForm(),
          audioFirer(() => audioState.micFormAt,
            'micFormAt | Sudden click/hit - acceleration | abs(peak(mic, 2))',
            (trigger, t) => Math.abs(peak(trigger.dataOrder(2))) > t)
        ],
        [
          () => spawnSamples(),
          audioFirer(() => audioState.micSampleAt,
            'micSampleAt | Mid - velocity | meanWeight(mic, 1, 0.4)',
            (trigger, t) => meanWeight(trigger.dataOrder(1), 0.4) > t)
        ],
        [
          () => spawnImageTargets(),
          audioFirer(() => audioState.micCamAt,
            'micCamAt | Mid - acceleration | meanWeight(mic, 2, 0.6)',
            (trigger, t) => meanWeight(trigger.dataOrder(2), 0.6) > t)
        ],
        [
          () => restart(),
          audioFirer(() => audioState.micSpawnAt,
            'micSpawnAt | Low end - acceleration | meanWeight(mic, 2, 0.3)',
            (trigger, t) => meanWeight(trigger.dataOrder(2), 0.3) > t)
        ]
      ]);

  // Returns a function to be executed for each `fire` pair (as above)
  const audioResponder = (trigger) => (fire) => trigger.fire(...fire);

  let trackResponder;
  let micResponder;

  const audioResponse = () => {
    // Sequential, and only one at a time, to calm the audio response
    let soundOutput = false;

    if(audioState.track > 0 && !track.paused) {
      soundOutput = trackFires.some(trackResponder ||
        (trackResponder = audioResponder(trackTrigger)));
    }

    if(!soundOutput && audioState.mic > 0 && micTrigger) {
      soundOutput = micFires.some(micResponder ||
        (micResponder = audioResponder(micTrigger)));
    }

    audioCache.clear();

    return soundOutput;
  };

  // Screen effects
  const screen = new Screen(gl);

  // Blur vignette

  const blurShader = shader(gl, screenVert, blurFrag);
  const blurDefaults = { radius: 3, limit: 0.5 };
  const blurState = { radius: 5, limit: 0.4 };

  blurShader.bind();
  Object.assign(blurShader.uniforms, blurState);

  // Background

  function toggleBase(background) {
    if(!background) {
      background = ((canvas.classList.contains('epok-dark'))? 'light' : 'dark');
    }

    canvas.classList.remove('epok-light');
    canvas.classList.remove('epok-dark');
    canvas.classList.add('epok-'+background);
  }

  toggleBase('dark');

  // Animation setup

  const tracks = {
    tendrils: tendrils.state,
    tendrils2: tendrils.state,
    tendrils3: tendrils.state,
    baseColor: tendrils.state.baseColor,
    flowColor: tendrils.state.flowColor,
    fadeColor: tendrils.state.fadeColor,
    spawn: resetSpawner.uniforms,
    opticalFlow: opticalFlowState,
    audio: audioState,
    blend: blend.alphas,
    blur: blurState,
    // Just for calls
    // @todo Fix the animation lib properly, not just by convention
    calls: {}
  };

  const player = {
    // The main player, tied to the track time
    track: new Player(map(() => [], tracks, {}), tracks),
    // A miscellaneous player, time to app time
    app: new Player({ main: [] }, { main: tendrils.state })
  };

  // timer.track.end = player.track.end()+2000;
  // timer.track.loop = true;

  track.addEventListener('seeked', () =>
    player.track.playFrom(track.currentTime*1000, 0));

  // @todo Test sequence - move to own file?

  // The values to reset everything to on restart - commented-out ones are
  // omitted so global settings can be applied more easily.
  // Use this as a guide to see which track should change which values.
  const tracksStart = {
    tendrils: {
      // rootNum: 512,

      autoClearView: false,
      autoFade: true,

      // damping: 0.043,
      // speedLimit: 0.01,

      forceWeight: 0.017,
      varyForce: -0.25,

      flowWeight: 1,
      varyFlow: 0.3,

      flowDecay: 0.003,
      flowWidth: 5,

      speedAlpha: 0.0005,
      colorMapAlpha: 0.5
    },
    tendrils2: {
      noiseWeight: 0.0003,
      varyNoise: 0.3,

      noiseScale: 1.5,
      varyNoiseScale: 1,

      noiseSpeed: 0.0006,
      varyNoiseSpeed: 0.05,
    },
    tendrils3: {
      target: 0.000005,
      varyTarget: 1,
      lineWidth: 1
    },
    baseColor: [0, 0, 0, 0.9],
    flowColor: [1, 1, 1, 0.1],
    fadeColor: [1, 1, 1, 0.05],
    spawn: {
      radius: 0.6,
      speed: 0.1
    },
    opticalFlow: { ...opticalFlowDefaults },
    audio: { ...audioDefaults },
    blend: [0, 0, 1],
    blur: { ...blurState },
    calls: null
  };

  // Restart, clean slate; begin with the inert, big bang - flow only

  const trackStartTime = 60;

  player.track.tracks.calls.to({
      call: [() => reset()],
      time: trackStartTime
    })
    .to({
      call: [
        () => {
          restart();
          toggleBase('dark');
        }
      ],
      time: 200
    });

  player.track.apply((track, key) => {
    const apply = tracksStart[key];

    track.to({
      to: apply,
      time: trackStartTime
    });

    return { apply };
  });

  // Intro info

  const intro = {
    togglers: Array.from(document.querySelectorAll('.epok-info-more-button')),
    more: document.querySelector('.epok-info-more'),

    toggle(toggle) {
      if(!intro.more) { return; }

      const show = ((typeof toggle !== 'undefined')?
          toggle
        : intro.more.classList.contains('epok-hide'));

      if(show) {
        intro.more.classList.remove('epok-hide');
      }
      else {
        intro.more.classList.add('epok-hide');
      }
    }
  };

  intro.togglers.forEach((moreToggler) =>
    moreToggler.addEventListener('click', () => intro.toggle()));

  // Quality settings

  const quality = {
    options: [
      {
        rootNum: defaultState.rootNum,
        damping: defaultState.damping
      },
      {
        rootNum: defaultState.rootNum*2,
        damping: defaultState.damping-0.001
      },
      {
        rootNum: defaultState.rootNum*4,
        damping: defaultState.damping-0.002
      }
    ],
    level: parseInt((settings.quality ||
        ((Math.max(window.innerWidth, window.innerHeight) < 800)? 0 : 1)),
      10),

    change(level = (quality.level+1)%quality.options.length) {
      const settings = quality.options[level];

      tendrils.setup(settings.rootNum);
      Object.assign(state, settings);
      restart();

      quality.level = level;
    },
    step: () => quality.change()
  };

  quality.change(quality.level);

  // Fullscreen

  // Needs to be called this way because calling the returned function directly is an
  // `Illegal Invocation`
  const requestFullscreen = prefixes('requestFullscreen', canvas);

  const fullscreen = (requestFullscreen && requestFullscreen.name &&
    { request: () => canvas[requestFullscreen.name]() });

  // The main loop
  function render() {
    const dt = timer.app.tick().dt;

    player.app.play(timer.app.time);

    if(track && track.currentTime >= 0) {
      timer.track.tick(track.currentTime*1000);

      trackControl && trackControl.tick(timer.track.time, track.paused);
    }

    // React to sound - from highest reaction to lowest, max one per frame
    /**
     * @todo Spectogram with frequencies on x-axis, waveform on y; or
     *     something better than this 1D list.
     */

    if(trackTrigger) {
      (trackTexture &&
        trackTexture.frequencies(trackTrigger.dataOrder(0)).apply());

      trackAnalyser.gain.gain
        // So we don't blow any speakers...
        .linearRampToValueAtTime(clamp(audioState.track, 0, 1),
          trackAnalyser.ctx.currentTime+0.5);

      trackTrigger.sample(dt);
    }

    if(micTrigger) {
      (micTexture &&
        micTexture.frequencies(micTrigger.dataOrder(0)).apply());

      micAnalyser.gain.gain
        .linearRampToValueAtTime(clamp(audioState.mic, 0, 10000),
          micAnalyser.ctx.currentTime+0.5);

      micTrigger.sample(dt);
    }

    audioResponse();

    // Blend everything to be

    const drawVideo = (appSettings.useMedia && appSettings.useCamera &&
      (video.readyState > 1));

    // Blend the color maps into tendrils one
    // @todo Only do this if necessary (skip if none or only one has alpha)

    blend.views[blendKeys.indexOf('video')] = ((drawVideo)?
      opticalFlow.buffers[0] : imageSpawner.buffer);

    blend.draw(tendrils.colorMap);

    // The main event
    tendrils.step().draw();

    if(tendrils.buffers.length) {
      // Blur to the screen

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      tendrils.drawFade();
      blurShader.bind();

      Object.assign(blurShader.uniforms, {
          view: tendrils.buffers[0].color[0].bind(1),
          resolution: tendrils.viewRes,
          time: tendrils.timer.time
        },
        blurState);

      screen.render();
      tendrils.stepBuffers();
    }

    // Draw inputs to flow

    gl.viewport(0, 0, ...tendrils.flow.shape);
    tendrils.flow.bind();

    // Flow lines

    flowInputs.trim(1/tendrils.state.flowDecay, timer.app.time);

    appSettings.pointerFlow && each((flowLine) => {
        Object.assign(flowLine.line.uniforms, tendrils.state);
        flowLine.update().draw();
      },
      flowInputs.active);

    // Optical flow

    // @todo Replace the image color map with one of these textures updated each frame.
    // @todo Blur for optical flow? Maybe Sobel as well?
    // @see https://github.com/princemio/ofxMIOFlowGLSL/blob/master/src/ofxMioFlowGLSL.cpp

    if(drawVideo && (Math.max(...rasterShape.video) > 0)) {
      videoCanvas.width = video.videoWidth;
      videoCanvas.height = video.videoHeight;

      videoContext.translate(((appSettings.flipVideoX)? video.videoWidth : 0),
        ((appSettings.flipVideoY)? video.videoHeight : 0));

      videoContext.scale(((appSettings.flipVideoX)? -1 : 1),
        ((appSettings.flipVideoY)? -1 : 1));

      videoContext.drawImage(video, 0, 0);

      opticalFlow.resize(rasterShape.video);
      opticalFlow.setPixels(videoCanvas);

      if(opticalFlowState.speed) {
        opticalFlow.update({
          speedLimit: state.speedLimit,
          time: timer.app.time,
          viewSize: tendrils.viewSize,
          ...opticalFlowState
        });

        screen.render();
      }

      opticalFlow.step();
    }
  }


  function resize() {
    canvas.width = self.innerWidth;
    canvas.height = self.innerHeight;
    tendrils.resize();
  }

  // Go

  self.addEventListener('resize', throttle(resize, 200), false);
  resize();

  tendrils.setup();
  respawn();

  // Control panel

  const gui = {
    main: new dat.GUI({ autoPlace: false }),
    showing: (''+settings.edit === 'true'),
    toggle: document.querySelector('.epok-editor-button')
  };

  const containGUI = Object.assign(document.createElement('div'),
    { className: 'epok-edit-controls' });

  const preventKeyClash = (e) => e.stopPropagation();

  gui.main.domElement.addEventListener('keydown', preventKeyClash);
  gui.main.domElement.addEventListener('keyup', preventKeyClash);

  function updateGUI(node = gui.main) {
    node.__controllers &&
      node.__controllers.forEach((control) => control.updateDisplay());

    for(let f in node.__folders) { updateGUI(node.__folders[f]); }
  }

  function toggleOpenGUI(open, node = gui.main, cascade = true) {
    ((open)? node.open() : node.close());

    if(cascade) {
      for(let f in node.__folders) { toggleOpenGUI(open, node.__folders[f]); }
    }
  }

  function toggleShowGUI(show = !gui.showing) {
    containGUI.classList[(show)? 'remove' : 'add']('epok-hide');
    gui.showing = show;
  }

  (gui.toggle &&
    gui.toggle.addEventListener('click', () => toggleShowGUI()));

  // Types of simple properties the GUI can handle with `.add`
  const simpleGUIRegEx = /^(object|array|undefined|null)$/gi;

  // Info

  const proxyGUI = { info: intro.toggle };

  gui.main.add(proxyGUI, 'info');

  // Root level

  const rootControls = { changeQuality: quality.step };

  if(fullscreen) { rootControls.fullscreen = fullscreen.request; }

  // State, animation, import/export

  const keyframe = (to = { ...state }, call = null) =>
    // @todo Apply full state to each player track
    player.track.tracks.tendrils.smoothTo({
      to,
      call,
      time: timer.track.time,
      ease: [0, 0.95, 1]
    });

  const showExport = ((''+settings.prompt_show !== 'false')?
      (...rest) => self.prompt(...rest)
    : (...rest) => console.log(...rest));

  Object.assign(rootControls, {
      showLink: () => showExport('Link:',
        location.href.replace((location.search || /$/gi),
          '?'+querystring.encode({
            ...settings,
            track: encodeURIComponent(appSettings.trackURL),
            mute: !audioState.audible,
            track_in: audioState.track,
            mic_in: audioState.mic,
            use_media: appSettings.useMedia,
            use_camera: appSettings.useCamer,
            use_mic: appSettings.useMic
          }))),

      keyframe
    });

  gui.main.add(appSettings, 'trackURL').onFinishChange(setupTrackURL);
  gui.main.add(appSettings, 'useMedia').onFinishChange(() => toggleMedia());

  gui.main.add(appSettings, 'staticImage').onFinishChange(() =>
      image.src = appSettings.staticImage);

  each((f, control) => gui.main.add(rootControls, control), rootControls);

  // Settings

  gui.settings = gui.main.addFolder('settings');

  for(let s in state) {
    if(!(typeof state[s]).match(simpleGUIRegEx)) {
      const control = gui.settings.add(state, s);

      // Some special cases

      if(s === 'rootNum') {
        control.onFinishChange((n) => {
          tendrils.setup(n);
          restart();
        });
      }
    }
  }

  // DAT.GUI's color controllers are a bit fucked.

  const colorDefaults = {
    baseColor: state.baseColor.slice(0, 3).map((c) => c*255),
    baseAlpha: state.baseColor[3],

    flowColor: state.flowColor.slice(0, 3).map((c) => c*255),
    flowAlpha: state.flowColor[3],

    fadeColor: state.fadeColor.slice(0, 3).map((c) => c*255),
    fadeAlpha: state.fadeColor[3]
  };

  const colorProxy = {...colorDefaults};

  const convertColors = () => {
    state.baseColor[3] = colorProxy.baseAlpha;
    Object.assign(state.baseColor,
        colorProxy.baseColor.map((c) => c/255));

    state.flowColor[3] = colorProxy.flowAlpha;
    Object.assign(state.flowColor,
      colorProxy.flowColor.map((c) => c/255));

    state.fadeColor[3] = colorProxy.fadeAlpha;
    Object.assign(state.fadeColor,
      colorProxy.fadeColor.map((c) => c/255));
  };

  gui.settings.addColor(colorProxy, 'flowColor').onChange(convertColors);
  gui.settings.add(colorProxy, 'flowAlpha').onChange(convertColors);

  gui.settings.addColor(colorProxy, 'baseColor').onChange(convertColors);
  gui.settings.add(colorProxy, 'baseAlpha').onChange(convertColors);

  gui.settings.addColor(colorProxy, 'fadeColor').onChange(convertColors);
  gui.settings.add(colorProxy, 'fadeAlpha').onChange(convertColors);

  convertColors();

  // Color map blend

  gui.blend = gui.main.addFolder('color blend');

  const blendProxy = reduce((proxy, k, i) => {
      proxy[k] = blend.alphas[i];

      return proxy;
    },
    blendKeys, {});

  const blendDefaults = { ...blendProxy };

  const convertBlend = () => reduce((alphas, v, k, proxy, i) => {
      alphas[i] = v;

      return alphas;
    },
    blendProxy, blend.alphas);

  for(let b = 0; b < blendKeys.length; ++b) {
    gui.blend.add(blendProxy, blendKeys[b]).onChange(convertBlend);
  }

  // Respawn

  gui.spawn = gui.main.addFolder('spawn');

  for(let s in resetSpawner.uniforms) {
    if(!(typeof resetSpawner.uniforms[s]).match(simpleGUIRegEx)) {
      gui.spawn.add(resetSpawner.uniforms, s);
    }
  }

  const resetSpawnerDefaults = { radius: 0.3, speed: 0.005 };

  // Optical flow

  gui.opticalFlow = gui.main.addFolder('optical flow');

  for(let s in opticalFlowState) {
    if(!(typeof opticalFlowState[s]).match(simpleGUIRegEx)) {
      gui.opticalFlow.add(opticalFlowState, s);
    }
  }

  // Reflow
  gui.reflow = gui.main.addFolder('reflow');
  gui.reflow.add(flowPixelState, 'scale', Object.keys(flowPixelScales));

  // Time

  gui.time = gui.main.addFolder('time');

  const timeSettings = ['paused', 'step', 'rate', 'end', 'loop'];

  timeSettings.forEach((t) => gui.time.add(timer.app, t));

  // Audio

  gui.audio = gui.main.addFolder('audio');

  for(let s in audioState) {
    const control = gui.audio.add(audioState, s);

    if(s === 'audible') {
      control.onChange((v) => {
        const out = (trackAnalyser.merger || trackAnalyser.analyser);

        ((v)? out.connect(trackAnalyser.ctx.destination) : out.disconnect());
      });
    }
  }

  // Blur

  gui.blur = gui.main.addFolder('blur');

  for(let s in blurDefaults) {
    if(!(typeof blurState[s]).match(simpleGUIRegEx)) {
      gui.blur.add(blurState, s);
    }
  }

  // Controls

  const controllers = {
    clear,
    clearView,
    clearFlow,
    respawn,
    spawnSamples,
    spawnImage,
    spawnFlow,
    spawnFastest,
    spawnForm,
    reset,
    restart,
    toggleBase,
    spawnImageTargets
  };

  gui.controls = gui.main.addFolder('controls');

  for(let c in controllers) { gui.controls.add(controllers, c); }

  // Presets

  gui.presets = gui.main.addFolder('presets');

  const presetters = {
    'Original Sing Light'() {
      Object.assign(state, {
        flowWidth: 5,
        colorMapAlpha: 0
      });

      Object.assign(resetSpawner.uniforms, {
        radius: 0.25,
        speed: 0.01
      });

      Object.assign(colorProxy, {
        baseAlpha: 0.5,
        baseColor: [0, 0, 255],
        flowAlpha: 1,
        flowColor: [0, 0, 0],
        fadeAlpha: Math.max(state.flowDecay, 0.05),
        fadeColor: [255, 255, 255]
      });

      toggleBase('dark');

      Object.assign(audioState, {
        // micSpawnAt: 0,
        micFormAt: audioDefaults.micFormAt*0.5,
        // micFlowAt: 0,
        // micFastAt: 0,
        // micCamAt: 0,
        micSampleAt: audioDefaults.micSampleAt*0.9
      });
    },
    'Original Sing Dark'() {
      Object.assign(state, {
        flowWidth: 5,
        colorMapAlpha: 0
      });

      Object.assign(resetSpawner.uniforms, {
        radius: 0.25,
        speed: 0.01
      });

      Object.assign(colorProxy, {
        baseAlpha: 0.9,
        baseColor: [0, 0, 255],
        flowAlpha: 1,
        flowColor: [0, 0, 0],
        fadeAlpha: Math.max(state.flowDecay, 0.05),
        fadeColor: [0, 0, 0]
      });

      toggleBase('dark');

      Object.assign(audioState, {
        // micSpawnAt: 0,
        micFormAt: audioDefaults.micFormAt*0.5,
        // micFlowAt: 0,
        // micFastAt: 0,
        // micCamAt: 0,
        micSampleAt: audioDefaults.micSampleAt*0.9
      });
    }
  };

  const presetAuto = {
    interval: null,
    current: 0,
    loop: appSettings.loopPresets
  };

  const wrapPresetter = (presetter, k) => {
    Object.assign(state, defaultState);
    Object.assign(resetSpawner.uniforms, resetSpawnerDefaults);
    Object.assign(flowPixelState, flowPixelDefaults);
    Object.assign(opticalFlowState, opticalFlowDefaults);
    Object.assign(colorProxy, colorDefaults);
    Object.assign(blendProxy, blendDefaults);
    Object.assign(blurState, blurDefaults);
    Object.assign(audioState, audioDefaults);

    quality.change(quality.level);
    presetter();

    updateGUI();
    convertColors();
    convertBlend();
    // restart();

    presetAuto.current = k;
  };

  const presetterKeys = Object.keys(presetters);

  presetterKeys.forEach((p, k) => {
    presetters[p] = wrapPresetter.bind(null, presetters[p], k);
    gui.presets.add(presetters, p);
  });

  const updatePresetAuto = (loop) => {
    presetAuto.loop = loop;
    clearInterval(presetAuto.interval);
    presetAuto.interval = null;

    if(presetAuto.loop) {
      presetAuto.interval = setInterval(() => {
          const next = (presetAuto.current+1)%presetterKeys.length;

          presetters[presetterKeys[next]]();
        },
        presetAuto.loop);
    }
  };

  gui.presets.add(presetAuto, 'loop').onFinishChange(updatePresetAuto);
  updatePresetAuto(presetAuto.loop);

  // Hide by default till the animation's over

  toggleOpenGUI(true);
  toggleOpenGUI(false, undefined, false);
  toggleShowGUI(gui.showing);

  // Add to the DOM

  containGUI.appendChild(gui.main.domElement);
  canvas.parentElement.appendChild(containGUI);

  function keyMash() {
    const callMap = {
      'H': () => toggleShowGUI(),
      '1': presetters['Original Sing Light'],
      '2': presetters['Original Sing Dark']
    };

    fullscreen && (callMap['F'] = fullscreen.request);

    document.body.addEventListener('keydown', (e) => {
        const key = vkey[e.keyCode];
        const call = callMap[key];

        if(call) {
          call(state);
          e.preventDefault();
          e.stopPropagation();
        }

        updateGUI();
      },
      false);

    document.body.addEventListener('keyup', (e) => {
        const key = vkey[e.keyCode];
        const call = callMap[key];

        if(call) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      false);
  }

  (''+settings.keyboard === 'true') && keyMash();

  // Need some stuff exposed.
  // @todo Come up with a better interface than this.
  const out = {
    ...controllers,
    tendrils,
    tracks,
    defaultState,
    audioDefaults,
    audioState,
    toggleMedia,
    timer
  };

  // Debug
  window.tendrils = out;

  (presetters[settings.preset] || presetters['Original Sing Dark'])();

  return out;
};
