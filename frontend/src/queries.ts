// TanStack Query hooks: every API call the pages make goes through one of
// these. Each query has a key; the library caches results by key, shares
// them between components, and re-fetches when told the data is out of date.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import * as api from './api'

const POLL_RUNNING_MS = 2_000
const POLL_IDLE_MS = 30_000

/** Who is logged in: the user, or null when not logged in (the API answers 401). */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.getMe()
      } catch (error) {
        if (error instanceof api.ApiError && error.status === 401) return null
        throw error
      }
    },
    staleTime: 60_000,
  })
}

function forgetAllBut(queryClient: ReturnType<typeof useQueryClient>, key: string) {
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== key })
  queryClient.getMutationCache().clear()
}

export function useLogin() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ username, password }: { username: string; password: string }) => api.login(username, password),
    onSuccess: (me) => {
      queryClient.setQueryData(['me'], me)
      // Anything cached before logging in was a 401: start clean.
      forgetAllBut(queryClient, 'me')
    },
  })
}

export function useLogout() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.logout,
    onSettled: () => {
      // Show the login page, and forget everything this session saw. The
      // login state is updated in place, not cleared: queryClient.clear()
      // would detach the page from it, and the page would never notice.
      queryClient.setQueryData(['me'], null)
      forgetAllBut(queryClient, 'me')
    },
  })
}

/**
 * When any request is refused with 401 (the session expired, or the admin
 * logged out in another tab), check who is logged in again. The layout then
 * sends the browser to the login page.
 */
export function useWatchForExpiredSession() {
  const queryClient = useQueryClient()
  useEffect(() => {
    const refused = (error: unknown) => error instanceof api.ApiError && error.status === 401
    const recheck = () => void queryClient.invalidateQueries({ queryKey: ['me'] })
    const stopQueries = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.query.queryKey[0] !== 'me' && refused(event.query.state.error)) recheck()
    })
    const stopMutations = queryClient.getMutationCache().subscribe((event) => {
      if (event.type === 'updated' && refused(event.mutation?.state.error)) recheck()
    })
    return () => {
      stopQueries()
      stopMutations()
    }
  }, [queryClient])
}

export function useHealth() {
  return useQuery({ queryKey: ['health'], queryFn: api.getHealth, refetchInterval: 10_000 })
}

/**
 * The scan list. This is what "watches" a running scan: while any scan is
 * running it re-fetches every 2 seconds, otherwise every 30 (which also
 * picks up scans started from the command line).
 */
export function useScans() {
  return useQuery({
    queryKey: ['scans'],
    queryFn: api.getScans,
    refetchInterval: (query) =>
      query.state.data?.some((scan) => scan.status === 'running')
        ? POLL_RUNNING_MS
        : POLL_IDLE_MS,
  })
}

export function useScan(id: number | undefined) {
  return useQuery({
    queryKey: ['scans', id],
    queryFn: () => api.getScan(id!),
    enabled: id !== undefined,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? POLL_RUNNING_MS : false),
  })
}

export function useStartScan() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.startScan,
    onSuccess: (scan) => {
      // Put the new "running" scan in the cache straight away. useScans then
      // sees a running scan and switches itself to fast polling.
      queryClient.setQueryData<api.ScanSummary[]>(['scans'], (scans) => [
        scan,
        ...(scans ?? []).filter((other) => other.id !== scan.id),
      ])
    },
    onError: () => {
      // Most likely "a scan is already running": fetch the list to show it.
      void queryClient.invalidateQueries({ queryKey: ['scans'], exact: true })
    },
  })
}

/**
 * Collection runs. Like the scan list, this polls quickly while a run is
 * going, so per-device results appear as each device finishes.
 */
export function useCollections() {
  return useQuery({
    queryKey: ['collections'],
    queryFn: api.getCollections,
    refetchInterval: (query) =>
      query.state.data?.some((run) => run.status === 'running') ? POLL_RUNNING_MS : POLL_IDLE_MS,
  })
}

export function useCollection(id: number | undefined) {
  return useQuery({
    queryKey: ['collections', id],
    queryFn: () => api.getCollection(id!),
    enabled: id !== undefined,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? POLL_RUNNING_MS : false),
  })
}

export function useStartCollection() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.startCollection,
    onSuccess: (run) => {
      // Show the new run and its pending devices at once; both queries then
      // see a running collection and poll quickly.
      queryClient.setQueryData<api.NetworkCollectionDetail>(['collections', run.id], run)
      queryClient.setQueryData<api.NetworkCollectionSummary[]>(['collections'], (runs) => [
        run,
        ...(runs ?? []).filter((other) => other.id !== run.id),
      ])
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: ['collections'], exact: true })
    },
  })
}

/** The current baseline, or null when none has been set (the API answers 404). */
export function useBaseline() {
  return useQuery({
    queryKey: ['baseline'],
    queryFn: async () => {
      try {
        return await api.getBaseline()
      } catch (error) {
        if (error instanceof api.ApiError && error.status === 404) return null
        throw error
      }
    },
  })
}

export function useSetBaseline() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ collectionId, note }: { collectionId: number; note: string }) =>
      api.setBaseline(collectionId, note),
    onSuccess: (baseline) => queryClient.setQueryData(['baseline'], baseline),
  })
}

/** Drift checks, polled quickly while one is running (its collection takes a while). */
export function useDriftChecks() {
  return useQuery({
    queryKey: ['drift-checks'],
    queryFn: api.getDriftChecks,
    refetchInterval: (query) =>
      query.state.data?.some((check) => check.status === 'running') ? POLL_RUNNING_MS : POLL_IDLE_MS,
  })
}

export function useDriftCheck(id: number | undefined) {
  return useQuery({
    queryKey: ['drift-checks', id],
    queryFn: () => api.getDriftCheck(id!),
    enabled: id !== undefined,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? POLL_RUNNING_MS : false),
  })
}

export function useStartDriftCheck() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.startDriftCheck,
    onSuccess: (check) => {
      queryClient.setQueryData<api.DriftCheck>(['drift-checks', check.id], check)
      queryClient.setQueryData<api.DriftCheckSummary[]>(['drift-checks'], (checks) => [
        check,
        ...(checks ?? []).filter((other) => other.id !== check.id),
      ])
      // The check starts a collection: let the collection list poll too.
      void queryClient.invalidateQueries({ queryKey: ['collections'], exact: true })
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: ['drift-checks'], exact: true })
    },
  })
}

/**
 * Refresh everything when a scan or a collection stops running (finished or
 * failed). Mounted once, in the layout, so it works on whichever page is open.
 */
export function useRefreshWhenScanFinishes() {
  const queryClient = useQueryClient()
  const { data: scans } = useScans()
  const { data: collections } = useCollections()
  const { data: checks } = useDriftChecks()
  const running =
    (scans?.some((scan) => scan.status === 'running') ?? false) ||
    (collections?.some((run) => run.status === 'running') ?? false) ||
    (checks?.some((check) => check.status === 'running') ?? false)
  const wasRunning = useRef(false)

  useEffect(() => {
    if (wasRunning.current && !running) {
      // Marks every cached query stale; the ones on screen re-fetch now.
      void queryClient.invalidateQueries()
    }
    wasRunning.current = running
  }, [running, queryClient])
}

/** The topology of one collection run, or of the latest when no id is given. */
export function useTopology(collectionId?: number) {
  return useQuery({
    queryKey: ['topology', collectionId ?? 'latest'],
    queryFn: () => api.getTopology(collectionId),
  })
}

export function useDevices() {
  return useQuery({ queryKey: ['devices'], queryFn: api.getDevices })
}

export function useDevice(id: number) {
  return useQuery({ queryKey: ['devices', id], queryFn: () => api.getDevice(id) })
}

export function useCollected(id: number, kind: api.CollectedKind) {
  return useQuery({
    queryKey: ['devices', id, kind],
    queryFn: () => api.getCollected(id, kind),
  })
}

export function useConfigs(id: number) {
  return useQuery({ queryKey: ['devices', id, 'configs'], queryFn: () => api.getConfigs(id) })
}

export function useConfig(id: number, backupId: number | undefined) {
  return useQuery({
    queryKey: ['devices', id, 'configs', backupId],
    queryFn: () => api.getConfig(id, backupId!),
    enabled: backupId !== undefined,
    // A stored backup never changes, so it never needs re-fetching.
    staleTime: Infinity,
  })
}

export function useConfigDiff(id: number, fromId: number | undefined, toId: number | undefined) {
  return useQuery({
    queryKey: ['devices', id, 'configs', 'diff', fromId, toId],
    queryFn: () => api.getConfigDiff(id, fromId!, toId!),
    enabled: fromId !== undefined && toId !== undefined,
    // Two stored backups always produce the same diff.
    staleTime: Infinity,
  })
}

export function useCollect(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.collectDevice(id),
    // The key prefix ['devices', id] covers the device and all its
    // collected data, so every tab re-fetches after a collection.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['devices', id] }),
  })
}

/** The most recent scan that completed: the reference for "is this device up?". */
export function useLatestCompletedScan() {
  const { data: scans } = useScans()
  return scans?.find((scan) => scan.status === 'completed')
}

/** A device counts as up if the latest completed scan saw it. */
export function isPresent(device: api.Device, latestScanId: number | undefined): boolean {
  return latestScanId !== undefined && device.latest_result?.scan_id === latestScanId
}
