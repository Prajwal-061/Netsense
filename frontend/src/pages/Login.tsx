import { useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { LogoMark, Wordmark } from '../components/Logo'
import NetworkBackdrop from '../components/NetworkBackdrop'
import { Button, ErrorBox, FieldLabel, Loading, StatusDot, TextInput } from '../components/ui'
import { useHealth, useLogin, useMe } from '../queries'

export default function Login() {
  const me = useMe()
  const health = useHealth()
  const login = useLogin()
  const navigate = useNavigate()
  const location = useLocation()
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  // Where the user was going before being sent here.
  const from = (location.state as { from?: string } | null)?.from ?? '/'
  const destination = from.startsWith('/login') ? '/' : from

  if (me.isPending) return <Loading label="Checking login..." />
  if (me.data) return <Navigate to={destination} replace />

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-canvas px-4">
      <NetworkBackdrop />
      <form
        className="relative w-full max-w-[340px] rounded border border-line bg-surface p-6 shadow-float"
        onSubmit={(event) => {
          event.preventDefault()
          login.mutate({ username, password }, { onSuccess: () => void navigate(destination, { replace: true }) })
        }}
      >
        <div className="mb-6 flex items-center gap-2.5">
          <LogoMark size={32} />
          <div className="leading-tight">
            <Wordmark className="block text-[19px]" />
            <span className="text-[12px] text-fg-muted">Network discovery &amp; diagnostics</span>
          </div>
        </div>
        <div className="space-y-3">
          <label className="block">
            <FieldLabel>Username</FieldLabel>
            <TextInput
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              required
              className="mt-1 block h-8 w-full"
            />
          </label>
          <label className="block">
            <FieldLabel>Password</FieldLabel>
            <TextInput
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              autoFocus
              required
              className="mt-1 block h-8 w-full"
            />
          </label>
          {login.isError && <ErrorBox error={login.error} />}
          {me.isError && <ErrorBox error={me.error} />}
          <Button type="submit" busy={login.isPending} className="h-8 w-full">
            Log in
          </Button>
        </div>
      </form>
      <p className="relative mt-4 text-[12px] text-fg-subtle">
        <StatusDot status={health.isError ? 'crit' : health.data ? 'ok' : 'unknown'}>
          {health.isError ? 'API offline' : health.data ? 'API online' : 'Connecting to the API'}
        </StatusDot>
      </p>
    </div>
  )
}
