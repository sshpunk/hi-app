import './style.css'

const app = document.querySelector('#app')

app.innerHTML = `
  <main class="scene" aria-label="Greeting">
    <div class="scene__media" aria-hidden="true">
      <div class="scene__portrait-rig" id="portrait-rig">
        <img
          class="portrait portrait--smile"
          src="/smiling-girl-hi.png"
          alt=""
          width="1024"
          height="1536"
          fetchpriority="high"
        />
        <img
          class="portrait portrait--frown"
          src="/frowning-girl-hi.png"
          alt=""
          width="864"
          height="1152"
          loading="eager"
        />
        <button
          class="nose-hotspot"
          type="button"
          id="nose"
          aria-label="Boop her nose"
          title="Nose"
        ></button>
      </div>
    </div>
    <div class="scene__wash" aria-hidden="true"></div>
    <div class="ambient" aria-hidden="true"></div>

    <p class="bubble" id="speech" role="status" aria-live="polite">Hi!</p>

    <section class="scene__content">
      <p class="brand">Hi.</p>
      <h1 class="headline">She’s glad you’re here.</h1>
      <p class="support">
        A simple little hello you can hear — smile optional, but hers is already on.
      </p>
      <div class="actions">
        <button class="btn btn--primary" type="button" id="say-hi">
          Say hi back
        </button>
        <button class="btn btn--ghost" type="button" id="again">
          Wave again
        </button>
      </div>
    </section>
  </main>
`

const phrases = [
  { text: 'Hi!', src: '/phrases/hi.wav', durationSec: 1.87 },
  { text: 'Hello!', src: '/phrases/hello.wav', durationSec: 1.87 },
  { text: 'How are you doing?', src: '/phrases/how-are-you.wav', durationSec: 1.9 },
  { text: 'Lovely to see you again.', src: '/phrases/lovely.wav', durationSec: 2.3 },
  { text: 'Stop clicking on me!', src: '/phrases/stop.wav', durationSec: 2.14, mood: 'annoyed' },
]

function noseImagePoint() {
  if (window.matchMedia('(max-width: 640px)').matches) {
    return { x: 0.52, y: 0.348 }
  }
  return { x: 0.5, y: 0.335 }
}

const PORTRAIT_SCALE = 1.04
const BOOP_COOLDOWN_MS = 700

const scene = document.querySelector('.scene')
const smilePortrait = document.querySelector('.portrait--smile')
const speech = document.querySelector('#speech')
const sayHi = document.querySelector('#say-hi')
const again = document.querySelector('#again')
const nose = document.querySelector('#nose')

const BOOP_SRC = '/phrases/boop.wav'
const AudioCtx = window.AudioContext || window.webkitAudioContext

/** @type {AudioContext | null} */
let audioCtx = null
/** @type {Map<string, ArrayBuffer>} */
const bytesBySrc = new Map()
/** @type {Map<string, AudioBuffer>} */
const bufferBySrc = new Map()
/** @type {Map<string, string>} */
const blobUrlBySrc = new Map()
/** @type {Promise<void> | null} */
let decodeAllPromise = null

let phraseIndex = 0
let hideTimer
let speakTimer
/** @type {{ stop: () => void, duration: number, addEventListener: Function } | null} */
let activeAudio = null
let audioUnlocked = false
let lastBoopAt = 0
let noseArmed = true

function setMood(mood) {
  scene.classList.toggle('is-annoyed', mood === 'annoyed')
}

function stopSpeaking() {
  clearTimeout(speakTimer)
  speakTimer = null
  scene.classList.remove('is-speaking', 'is-speaking-annoyed')
}

function startSpeaking(durationSec, { annoyed = false } = {}) {
  stopSpeaking()
  const ms = Math.max(650, Math.round(durationSec * 1000))
  scene.style.setProperty('--talk-ms', `${ms}ms`)
  scene.classList.toggle('is-speaking-annoyed', annoyed)
  // Restart the keyframed nod even if she was already speaking.
  scene.classList.remove('is-speaking')
  void scene.offsetWidth
  scene.classList.add('is-speaking')
  speakTimer = setTimeout(stopSpeaking, ms)
}

function stopActiveAudio() {
  if (!activeAudio) return
  try {
    activeAudio.stop()
  } catch {
    // ignore already-stopped sources
  }
  activeAudio = null
}

function ensureAudioContext() {
  if (!AudioCtx) return null
  if (!audioCtx) {
    try {
      audioCtx = new AudioCtx()
    } catch {
      audioCtx = null
    }
  }
  return audioCtx
}

async function decodePendingBuffers(ctx) {
  const jobs = []
  for (const [src, bytes] of bytesBySrc) {
    if (bufferBySrc.has(src)) continue
    jobs.push(
      ctx
        .decodeAudioData(bytes.slice(0))
        .then((audioBuffer) => {
          bufferBySrc.set(src, audioBuffer)
          const phrase = phrases.find((p) => p.src === src)
          if (phrase) phrase.durationSec = audioBuffer.duration
        })
        .catch(() => {
          // HTMLAudio blob fallback still works without a decoded buffer.
        }),
    )
  }
  await Promise.all(jobs)
}

function kickDecode() {
  const ctx = audioCtx
  if (!ctx || decodeAllPromise) return decodeAllPromise
  decodeAllPromise = decodePendingBuffers(ctx).finally(() => {
    // Allow later arrivals (slow fetches) to decode too.
    decodeAllPromise = null
  })
  return decodeAllPromise
}

/**
 * Must run synchronously inside a user-gesture stack (pointerdown/click).
 * Create + resume AudioContext here — muted HTMLAudio unlock is not enough
 * in Safari / strict autoplay, and a context created on load stays stuck.
 */
function unlockAudio() {
  const ctx = ensureAudioContext()
  if (!ctx) {
    audioUnlocked = true
    return Promise.resolve(true)
  }
  kickDecode()
  if (ctx.state === 'running') {
    audioUnlocked = true
    return Promise.resolve(true)
  }
  try {
    const resume = ctx.resume()
    if (!resume || typeof resume.then !== 'function') {
      audioUnlocked = true
      return Promise.resolve(true)
    }
    return resume
      .then(() => {
        audioUnlocked = ctx.state === 'running'
        return audioUnlocked
      })
      .catch(() => false)
  } catch {
    return Promise.resolve(false)
  }
}

function makePlaybackHandle(durationSec, stopFn) {
  const endedListeners = new Set()
  let endedTimer = null
  let stopped = false

  const notifyEnded = () => {
    if (stopped) return
    stopped = true
    endedListeners.forEach((fn) => {
      try {
        fn()
      } catch {
        // ignore listener errors
      }
    })
    endedListeners.clear()
  }

  if (durationSec > 0) {
    endedTimer = window.setTimeout(notifyEnded, Math.round(durationSec * 1000))
  }

  return {
    duration: durationSec,
    addEventListener(type, fn, options) {
      if (type !== 'ended' || typeof fn !== 'function') return
      if (options && options.once) {
        const wrap = () => {
          endedListeners.delete(wrap)
          fn()
        }
        endedListeners.add(wrap)
      } else {
        endedListeners.add(fn)
      }
    },
    stop() {
      if (endedTimer != null) {
        clearTimeout(endedTimer)
        endedTimer = null
      }
      stopped = true
      endedListeners.clear()
      stopFn()
    },
  }
}

function playViaWebAudio(src, volume) {
  const ctx = ensureAudioContext()
  const buffer = bufferBySrc.get(src)
  if (!ctx || !buffer) return null

  // Gesture may have left the context suspended; resume without awaiting so
  // start() still rides the same user-activation where possible.
  if (ctx.state === 'suspended') {
    try {
      ctx.resume()
    } catch {
      // ignore
    }
  }

  const gain = ctx.createGain()
  gain.gain.value = volume
  gain.connect(ctx.destination)

  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(gain)

  let stopped = false
  const stopFn = () => {
    if (stopped) return
    stopped = true
    try {
      source.stop()
    } catch {
      // ignore
    }
    try {
      source.disconnect()
      gain.disconnect()
    } catch {
      // ignore
    }
  }

  const handle = makePlaybackHandle(buffer.duration, stopFn)
  source.onended = () => {
    if (activeAudio === handle) activeAudio = null
  }

  try {
    source.start(0)
  } catch {
    stopFn()
    return null
  }

  return handle
}

function playViaHtmlAudio(src, volume) {
  const url = blobUrlBySrc.get(src) || src
  const clip = new Audio(url)
  clip.preload = 'auto'
  clip.volume = volume

  const stopFn = () => {
    try {
      clip.pause()
    } catch {
      // ignore
    }
    try {
      clip.currentTime = 0
    } catch {
      // ignore
    }
  }

  const knownDuration =
    (bufferBySrc.get(src) && bufferBySrc.get(src).duration) ||
    phrases.find((p) => p.src === src)?.durationSec ||
    0
  const handle = makePlaybackHandle(knownDuration, stopFn)

  const attempt = () => clip.play()
  const play = attempt()
  if (play && typeof play.catch === 'function') {
    play.catch(() => {
      // Still inside a turn after unlock — one immediate retry only.
      attempt().catch(() => {})
    })
  }

  clip.addEventListener(
    'ended',
    () => {
      if (activeAudio === handle) activeAudio = null
    },
    { once: true },
  )

  return handle
}

function playClip(src, { volume = 1 } = {}) {
  stopActiveAudio()
  // Prefer Web Audio only when the context is already running and the clip is
  // decoded. Otherwise play a prefetched blob via HTMLAudio so play() stays
  // inside the user gesture with no network/readyState race.
  const ctx = audioCtx
  const canWeb = Boolean(ctx && ctx.state === 'running' && bufferBySrc.has(src))
  const handle =
    (canWeb ? playViaWebAudio(src, volume) : null) || playViaHtmlAudio(src, volume)
  activeAudio = handle
  return handle
}

function playPhrase(index) {
  const phrase = phrases[index]
  if (!phrase || phrase.missing) {
    stopActiveAudio()
    return null
  }
  return playClip(phrase.src)
}

function playBoop() {
  unlockAudio()
  // Brief interrupt only — does not advance the greeting playlist.
  stopActiveAudio()
  stopSpeaking()
  // If we cut off “Stop clicking…”, drop the frown so it cannot stick.
  setMood(null)

  playClip(BOOP_SRC)

  const visibleMs = 1200
  speech.textContent = 'Boop!'
  speech.style.setProperty('--bubble-ms', `${visibleMs}ms`)
  speech.classList.remove('is-visible')
  void speech.offsetWidth
  speech.classList.add('is-visible')

  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    speech.classList.remove('is-visible')
  }, visibleMs)
}

function showBubble(phrase, visibleMs) {
  speech.textContent = phrase.text
  speech.style.setProperty('--bubble-ms', `${visibleMs}ms`)
  setMood(phrase.mood)
  speech.classList.remove('is-visible')
  void speech.offsetWidth
  speech.classList.add('is-visible')

  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    speech.classList.remove('is-visible')
    setMood(null)
  }, visibleMs)
}

function greet() {
  // Caller should be a user gesture (button click). Unlock first while
  // still in that gesture stack (sync resume — do not await).
  unlockAudio()
  const index = phraseIndex % phrases.length
  phraseIndex += 1
  const phrase = phrases[index]
  const audio = playPhrase(index)
  const durationSec =
    audio && Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration
      : phrase.durationSec
  const visibleMs = Math.max(2800, Math.round(durationSec * 1000) + 900)
  showBubble(phrase, visibleMs)
  startSpeaking(durationSec, { annoyed: phrase.mood === 'annoyed' })
  if (audio) {
    audio.addEventListener('ended', stopSpeaking, { once: true })
  }
}

/** Visual-only intro — never call play() without a user gesture. */
function softIntro() {
  const phrase = phrases[0]
  const visibleMs = Math.max(2800, Math.round(phrase.durationSec * 1000) + 900)
  showBubble(phrase, visibleMs)
  // Leave phraseIndex at 0 so the first click speaks “Hi!” with audio.
}

function onNosePointerEnter(event) {
  event.stopPropagation()
  if (!noseArmed) return
  const now = Date.now()
  if (now - lastBoopAt < BOOP_COOLDOWN_MS) return
  noseArmed = false
  lastBoopAt = now
  playBoop()
}

function onNosePointerLeave() {
  // Re-arm only after the cursor leaves the tip so jitter does not spam.
  noseArmed = true
}

function positionNoseHotspot() {
  // Skip mid-nod: nose lives inside the talking rig, so last layout coords
  // stay correct in local space while the parent transform animates.
  if (scene.classList.contains('is-speaking')) return

  const nw = smilePortrait.naturalWidth || 1024
  const nh = smilePortrait.naturalHeight || 1536
  const rect = smilePortrait.getBoundingClientRect()
  const sceneRect = scene.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return

  const layoutW = rect.width / PORTRAIT_SCALE
  const layoutH = rect.height / PORTRAIT_SCALE
  const layoutLeft = rect.left + (rect.width - layoutW) / 2
  const layoutTop = rect.top + (rect.height - layoutH) / 2

  const objectPositionY = window.matchMedia('(max-width: 640px)').matches
    ? 0.12
    : window.matchMedia('(min-width: 900px)').matches
      ? 0.22
      : 0.18
  const objectPositionX = window.matchMedia('(max-width: 640px)').matches
    ? 0.58
    : 0.5

  const cover = Math.max(layoutW / nw, layoutH / nh)
  const dispW = nw * cover
  const dispH = nh * cover
  const offsetX = (layoutW - dispW) * objectPositionX
  const offsetY = (layoutH - dispH) * objectPositionY

  const point = noseImagePoint()
  let x = layoutLeft - sceneRect.left + offsetX + point.x * dispW
  let y = layoutTop - sceneRect.top + offsetY + point.y * dispH

  const cx = rect.left - sceneRect.left + rect.width / 2
  const cy = rect.top - sceneRect.top + rect.height / 2
  x = cx + (x - cx) * PORTRAIT_SCALE
  y = cy + (y - cy) * PORTRAIT_SCALE

  const noseSize = Math.max(28, Math.min(layoutW, layoutH) * 0.045)
  nose.style.left = `${x}px`
  nose.style.top = `${y}px`
  nose.style.width = `${noseSize}px`
  nose.style.height = `${noseSize}px`
}

// Unlock during pointerdown so the gesture still covers the later play().
sayHi.addEventListener('pointerdown', () => {
  unlockAudio()
})
again.addEventListener('pointerdown', () => {
  unlockAudio()
})
sayHi.addEventListener('click', greet)
again.addEventListener('click', greet)
nose.addEventListener('pointerenter', onNosePointerEnter)
nose.addEventListener('pointerleave', onNosePointerLeave)

window.addEventListener('resize', positionNoseHotspot)
if (smilePortrait.complete) {
  positionNoseHotspot()
} else {
  smilePortrait.addEventListener('load', positionNoseHotspot, { once: true })
}
window.setTimeout(positionNoseHotspot, 50)
window.setTimeout(positionNoseHotspot, 400)
window.setTimeout(positionNoseHotspot, 1000)

// Soft visual intro only — audio starts on the first button gesture.
window.setTimeout(softIntro, 900)

async function loadClip(src) {
  const res = await fetch(src, { cache: 'force-cache' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const bytes = await res.arrayBuffer()
  bytesBySrc.set(src, bytes)
  blobUrlBySrc.set(src, URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })))
  // Decode only after a gesture creates the AudioContext — do not construct
  // AudioContext during page load (Safari leaves it permanently suspended).
  if (audioCtx) kickDecode()
}

// Prefetch WAV bytes + blob URLs so the first click is not racing the network.
;[...phrases.map((p) => p.src), BOOP_SRC].forEach((src) => {
  loadClip(src).catch(() => {
    const phrase = phrases.find((p) => p.src === src)
    if (phrase) phrase.missing = true
  })
})
