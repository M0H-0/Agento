import { useEffect, useState } from 'react'

function App(): React.JSX.Element {
  const [pong, setPong] = useState<string | null>(null)

  // Proof of wiring: main answers the ping over the typed preload bridge.
  // Placeholder UI — replaced by the assistant-ui Thread in M0.2.
  useEffect(() => {
    window.agento.ping().then(setPong).catch(console.error)
  }, [])

  return (
    <main className="container">
      <h1>Agento</h1>
      <p>{pong ? `IPC bridge ready (${pong})` : 'Connecting to main process…'}</p>
    </main>
  )
}

export default App
