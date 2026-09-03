import { useEffect, useState } from 'react'

type Status = 'starting' | 'healthy' | 'unhealthy'

// Fixed chrome dot reflecting the intelligence sidecar's /health (docs/02
// §2.4): gray while starting, green when healthy, red when unhealthy.
function SidecarStatusDot(): React.JSX.Element {
  const [status, setStatus] = useState<Status>('starting')
  const [detail, setDetail] = useState<string | undefined>(undefined)

  useEffect(() => {
    // Subscribe before the initial pull so a transition between the two isn't
    // missed (M0.3's subscribe-before-invoking rule); duplicate applies are
    // harmless. Plain useState — zustand arrives with the first panel (M3).
    const unsubscribe = window.agento.sidecar.onStatus((event) => {
      setStatus(event.status)
      setDetail(event.detail)
    })
    window.agento.sidecar
      .getStatus()
      .then((event) => {
        setStatus(event.status)
        setDetail(event.detail)
      })
      .catch(() => {
        // Handler failure keeps the optimistic 'starting' gray.
      })
    return unsubscribe
  }, [])

  const label = `Sidecar: ${status}${detail === undefined ? '' : ` — ${detail}`}`

  return (
    <div
      className={`status-dot status-dot--${status}`}
      title={label}
      role="status"
      aria-label={label}
    />
  )
}

export default SidecarStatusDot
