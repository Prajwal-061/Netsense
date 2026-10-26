import { useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Button, ErrorBox, Loading } from '../components/ui'
import { useLogin, useMe } from '../queries'

export default function Login() {
  const me = useMe()
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
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <form
        className="w-full max-w-sm space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
        onSubmit={(event) => {
          event.preventDefault()
          login.mutate({ username, password }, { onSuccess: () => void navigate(destination, { replace: true }) })
        }}
      >
        <div className="flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="h-7 w-7" />
          <h1 className="text-lg font-semibold text-slate-900">NetSense</h1>
        </div>
        <p className="text-sm text-slate-600">Log in as the admin to use the dashboard.</p>
        <label className="block text-sm font-medium text-slate-700">
          Username
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            required
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            autoFocus
            required
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </label>
        {login.isError && <ErrorBox error={login.error} />}
        {me.isError && <ErrorBox error={me.error} />}
        <Button type="submit" busy={login.isPending} className="w-full">
          Log in
        </Button>
      </form>
    </div>
  )
}
