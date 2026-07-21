import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

function Photo({ src, alt, className = '' }) {
  return (
    <div
      className={`screen-photo ${className}`}
      role="img"
      aria-label={alt}
      style={{ backgroundImage: `url(${src})` }}
    />
  )
}

function useNativeKeyboard(active) {
  const baselineHeight = useRef(Math.max(window.innerHeight, window.visualViewport?.height || 0))
  const previousActive = useRef(active)
  const waitingForKeyboardClose = useRef(false)
  const [isOpen, setIsOpen] = useState(false)

  useEffect(() => {
    const viewport = window.visualViewport
    const root = document.documentElement

    const measure = () => {
      const visibleHeight = viewport?.height || window.innerHeight
      const offsetTop = viewport?.offsetTop || 0

      if (previousActive.current && !active) waitingForKeyboardClose.current = true
      if (active) waitingForKeyboardClose.current = false
      previousActive.current = active

      const previousOffset = Math.max(0, baselineHeight.current - visibleHeight - offsetTop)
      if (!active && (!waitingForKeyboardClose.current || previousOffset < 80)) {
        baselineHeight.current = Math.max(window.innerHeight, visibleHeight + offsetTop)
        waitingForKeyboardClose.current = false
      }

      const keyboardOffset = Math.max(0, baselineHeight.current - visibleHeight - offsetTop)
      root.style.setProperty('--app-height', `${baselineHeight.current}px`)
      root.style.setProperty('--keyboard-offset', `${keyboardOffset}px`)
      setIsOpen(active && keyboardOffset > 80)
    }

    measure()
    viewport?.addEventListener('resize', measure)
    viewport?.addEventListener('scroll', measure)
    window.addEventListener('resize', measure)

    return () => {
      viewport?.removeEventListener('resize', measure)
      viewport?.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [active])

  return isOpen
}

function useLiveClock() {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const weekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' })
    .format(now)
    .replace(/[.,]/g, '')
  const calendarDate = new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
  }).format(now)

  return {
    date: `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} ${calendarDate}`,
    time: new Intl.DateTimeFormat('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(now),
  }
}

function useFullViewportHeight() {
  useEffect(() => {
    const viewport = window.visualViewport
    const updateHeight = () => {
      const visibleHeight = viewport?.height || window.innerHeight
      const offsetTop = viewport?.offsetTop || 0
      const fullHeight = Math.max(window.innerHeight, visibleHeight + offsetTop)
      document.documentElement.style.setProperty('--app-height', `${fullHeight}px`)
      document.documentElement.style.setProperty('--keyboard-offset', '0px')
    }

    updateHeight()
    viewport?.addEventListener('resize', updateHeight)
    viewport?.addEventListener('scroll', updateHeight)
    window.addEventListener('resize', updateHeight)

    return () => {
      viewport?.removeEventListener('resize', updateHeight)
      viewport?.removeEventListener('scroll', updateHeight)
      window.removeEventListener('resize', updateHeight)
    }
  }, [])
}

function NotesPhotoScreen({ title, setTitle, onDone }) {
  const inputRef = useRef(null)
  const [focused, setFocused] = useState(false)
  const keyboardOpen = useNativeKeyboard(focused)
  const titleClass = title.length > 42 ? 'title-small' : title.length > 26 ? 'title-medium' : ''

  return (
    <main className="photo-stage notes-photo-stage" onContextMenu={(event) => event.preventDefault()}>
      <Photo src="./assets/notes-screen.jpg" alt="Экран заметок" className="notes-top-photo" />
      <div className="status-photo-mask" aria-hidden="true" />

      <label className="photo-title-zone">
        <span className="sr-only">Заголовок заметки</span>
        <input
          ref={inputRef}
          className={`photo-title-input ${titleClass}`}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              onDone()
            }
          }}
          aria-label="Заголовок заметки"
          autoCapitalize="sentences"
          autoComplete="off"
          autoCorrect="on"
          enterKeyHint="done"
          inputMode="text"
          spellCheck="true"
        />
      </label>

      <button type="button" className="done-hit" aria-label="Готово" onClick={onDone} />

      <img
        className={`notes-toolbar-photo ${keyboardOpen ? 'toolbar-visible' : ''}`}
        src="./assets/notes-toolbar.png"
        alt="Панель форматирования заметки"
        draggable="false"
      />
    </main>
  )
}

function LockPhotoScreen({ title, onBack }) {
  const clock = useLiveClock()
  useFullViewportHeight()

  useEffect(() => {
    const handleEscape = (event) => {
      if (event.key === 'Escape') onBack()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [onBack])

  const focusClass = title.length > 32 ? 'focus-small' : title.length > 20 ? 'focus-medium' : ''

  return (
    <main className="photo-stage lock-photo-stage" onDoubleClick={onBack} onContextMenu={(event) => event.preventDefault()}>
      <img className="lock-emblem-photo" src="./assets/lock-emblem.png" alt="Герб" draggable="false" />
      <img className="lock-bottom-photo" src="./assets/lock-bottom.png" alt="Фонарик, камера и нижняя полоска" draggable="false" />
      <div className="status-photo-mask" aria-hidden="true" />
      <div className="lock-clock-mask" aria-hidden="true" />
      <time className="lock-date" dateTime={new Date().toISOString()}>{clock.date}</time>
      <time className="lock-time">{clock.time}</time>
      <div className={`photo-focus-title ${focusClass}`} aria-live="polite">
        {title || 'Без названия'}
      </div>
    </main>
  )
}

function App() {
  const [screen, setScreen] = useState('notes')
  const [title, setTitle] = useState(() => localStorage.getItem('photo-note-title-v2') || '')

  const saveAndOpen = () => {
    localStorage.setItem('photo-note-title-v2', title)
    document.activeElement?.blur()
    setScreen('lock')
  }

  return screen === 'notes'
    ? <NotesPhotoScreen title={title} setTitle={setTitle} onDone={saveAndOpen} />
    : <LockPhotoScreen title={title} onBack={() => setScreen('notes')} />
}

if ('serviceWorker' in navigator && import.meta.env.PROD && !['127.0.0.1', 'localhost'].includes(location.hostname)) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'))
}

createRoot(document.getElementById('root')).render(<App />)
