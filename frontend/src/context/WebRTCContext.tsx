import { createContext, useContext, useRef, useState } from 'react'
import { useStore } from '../store/store'

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:8080'

interface WebRTCContextValue {
  startCall: (targetPeerId: string) => Promise<void>
  acceptCall: () => Promise<void>
  hangup: () => void
  handleSignal: (from_id: string, signal_type: string, payload: Record<string, unknown>) => Promise<void>
  remoteStream: MediaStream | null
  audioRef: React.RefObject<HTMLAudioElement | null>
}

const WebRTCContext = createContext<WebRTCContextValue>(null!)

export function WebRTCProvider({ children }: { children: React.ReactNode }) {
  const peerConnection = useRef<RTCPeerConnection | null>(null)
  const localStream = useRef<MediaStream | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const pendingOffer = useRef<RTCSessionDescriptionInit | null>(null)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)

  const store = useStore()

  const createPC = () => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })

    pc.onicecandidate = e => {
      if (e.candidate && useStore.getState().callPeerId) {
        fetch(`${BASE}/api/signal`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: useStore.getState().callPeerId,
            signal_type: 'ice-candidate',
            payload: e.candidate.toJSON(),
          }),
        })
      }
    }

    pc.ontrack = e => {
      setRemoteStream(e.streams[0])
      if (audioRef.current) audioRef.current.srcObject = e.streams[0]
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') store.setCallState('active')
      if (pc.connectionState === 'disconnected') hangup()
    }

    return pc
  }

  const startCall = async (targetPeerId: string) => {
    store.setCallPeerId(targetPeerId)
    store.setCallState('calling')

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    localStream.current = stream

    const pc = createPC()
    stream.getTracks().forEach(t => pc.addTrack(t, stream))

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    await fetch(`${BASE}/api/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: targetPeerId,
        signal_type: 'offer',
        payload: { sdp: offer.sdp, type: offer.type },
      }),
    })

    peerConnection.current = pc
  }

  const acceptCall = async () => {
    if (!pendingOffer.current || !useStore.getState().callPeerId) return

    const from_id = useStore.getState().callPeerId!
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    localStream.current = stream

    const pc = createPC()
    stream.getTracks().forEach(t => pc.addTrack(t, stream))

    await pc.setRemoteDescription(new RTCSessionDescription(pendingOffer.current))
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    await fetch(`${BASE}/api/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: from_id,
        signal_type: 'answer',
        payload: { sdp: answer.sdp, type: answer.type },
      }),
    })

    peerConnection.current = pc
    pendingOffer.current = null
    store.setIncomingCall(null)
  }

  const handleSignal = async (
    from_id: string,
    signal_type: string,
    payload: Record<string, unknown>
  ) => {
    if (signal_type === 'offer') {
      pendingOffer.current = payload as unknown as RTCSessionDescriptionInit
      store.setCallPeerId(from_id)
      store.setCallState('ringing')
      store.setIncomingCall({
        from_id,
        name: useStore.getState().peers.find(p => p.peer_id === from_id)?.name ?? from_id,
      })
      return
    }

    if (signal_type === 'answer' && peerConnection.current) {
      await peerConnection.current.setRemoteDescription(
        new RTCSessionDescription(payload as unknown as RTCSessionDescriptionInit)
      )
      store.setCallState('active')
    }

    if (signal_type === 'ice-candidate' && peerConnection.current) {
      await peerConnection.current.addIceCandidate(
        new RTCIceCandidate(payload as unknown as RTCIceCandidateInit)
      )
    }

    if (signal_type === 'hangup') {
      hangup()
    }
  }

  const hangup = () => {
    peerConnection.current?.close()
    peerConnection.current = null
    localStream.current?.getTracks().forEach(t => t.stop())
    localStream.current = null
    pendingOffer.current = null
    setRemoteStream(null)

    const peerId = useStore.getState().callPeerId
    if (peerId) {
      fetch(`${BASE}/api/signal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: peerId, signal_type: 'hangup', payload: {} }),
      })
    }

    store.setCallState('idle')
    store.setCallPeerId(null)
    store.setIncomingCall(null)
  }

  return (
    <WebRTCContext.Provider value={{ startCall, acceptCall, hangup, handleSignal, remoteStream, audioRef }}>
      {children}
    </WebRTCContext.Provider>
  )
}

export const useWebRTC = () => useContext(WebRTCContext)
