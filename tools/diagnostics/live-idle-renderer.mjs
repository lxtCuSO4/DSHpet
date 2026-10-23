// Installed temporarily through webContents.executeJavaScript; playback is unchanged.
export function installLiveIdleObserver(seconds) {
  if (window.__liveIdleObserver) throw new Error('A live idle observer already exists');
  const sprite = sprites[0];
  const data = { timeOrigin: performance.timeOrigin, start: performance.now(),
    events: [], raf: [], videoFrames: [], stopped: false };
  const videos = [sprite.videoA, sprite.videoB];
  const listeners = [], methods = [], frameHandles = new Map();
  let rafHandle, timer;
  const videoState = (video) => ({ currentTime: video.currentTime, duration: video.duration,
    readyState: video.readyState, loop: video.loop, paused: video.paused, ended: video.ended,
    opacity: getComputedStyle(video).opacity, visibility: getComputedStyle(video).visibility,
    className: video.className,
    totalFrames: video.getVideoPlaybackQuality().totalVideoFrames,
    droppedFrames: video.getVideoPlaybackQuality().droppedVideoFrames });
  const state = (kind) => ({ kind, at: performance.now(), wallMs: Date.now(),
    front: sprite.front, generation: sprite.gen, pending: Boolean(sprite.pending),
    animation: sprite.anim, workState: sprite.workState, dragging: sprite.dragState.active,
    A: videoState(videos[0]), B: videoState(videos[1]) });
  for (const name of ['switchTo', 'playIdle', 'playOnce', 'handleEnded']) {
    const original = sprite[name];
    const wrapper = function (...args) {
      data.events.push({ ...state(name), args });
      return original.apply(this, args);
    };
    sprite[name] = wrapper;
    methods.push({ name, original, wrapper });
  }
  for (const [slot, video] of videos.entries()) {
    for (const kind of ['ended', 'emptied', 'loadstart', 'loadedmetadata', 'loadeddata',
      'canplay', 'playing', 'pause', 'waiting', 'seeking', 'seeked', 'error']) {
      const listener = () => data.events.push({ ...state(kind), slot });
      video.addEventListener(kind, listener);
      listeners.push({ video, kind, listener });
    }
    const onFrame = (_now, meta) => {
      data.videoFrames.push({ at: performance.now(), wallMs: Date.now(), slot,
        front: sprite.front, mediaTime: meta.mediaTime, presentedFrames: meta.presentedFrames,
        expectedDisplayTime: meta.expectedDisplayTime, presentationTime: meta.presentationTime });
      if (!data.stopped) frameHandles.set(video, video.requestVideoFrameCallback(onFrame));
    };
    frameHandles.set(video, video.requestVideoFrameCallback(onFrame));
  }
  const mutations = new MutationObserver((rows) => {
    for (const row of rows) data.events.push({ ...state('attribute'),
      slot: videos.indexOf(row.target), attribute: row.attributeName, oldValue: row.oldValue });
  });
  for (const video of videos) mutations.observe(video,
    { attributes: true, attributeOldValue: true, attributeFilter: ['class', 'style', 'src'] });
  let lastFront;
  const onRaf = () => {
    const front = videos[sprite.front];
    if (lastFront !== sprite.front || sprite.pending || front.readyState < 2 ||
      front.currentTime < 0.6 || front.duration - front.currentTime < 0.6) data.raf.push(state('raf'));
    lastFront = sprite.front;
    if (!data.stopped) rafHandle = requestAnimationFrame(onRaf);
  };
  rafHandle = requestAnimationFrame(onRaf);
  const stop = () => {
    if (data.stopped) return data;
    data.stopped = true;
    clearTimeout(timer);
    cancelAnimationFrame(rafHandle);
    mutations.disconnect();
    for (const { video, kind, listener } of listeners) video.removeEventListener(kind, listener);
    for (const [video, handle] of frameHandles) video.cancelVideoFrameCallback(handle);
    for (const { name, original, wrapper } of methods) if (sprite[name] === wrapper) sprite[name] = original;
    data.end = performance.now();
    return data;
  };
  window.__liveIdleObserver = { data, stop };
  timer = setTimeout(stop, (seconds + 15) * 1000);
  const rect = sprite.videoA.getBoundingClientRect();
  return { ...state('setup'), stage: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    timeOrigin: data.timeOrigin, transition: getComputedStyle(sprite.videoA).transition,
    dpr: devicePixelRatio, observerInstalled: true };
}
