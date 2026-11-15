import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { useViewMode } from './view_mode'

// Each view is its own lazy chunk so a phone never downloads the desktop
// bundle (Recharts and every desktop panel) and desktop never downloads the
// mobile one (mobile-spec.md G3/G4).
const DesktopApp = lazy(() => import('./App.jsx'))
const MobileApp = lazy(() => import('./mobile/MobileApp.jsx'))

function Root() {
  const mode = useViewMode()
  return (
    <Suspense fallback={null}>
      {mode === 'mobile' ? <MobileApp /> : <DesktopApp />}
    </Suspense>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
