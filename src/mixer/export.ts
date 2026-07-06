/**
 * WAV serialisation and download helpers. `audioBufferToWavBlob` writes a
 * rendered AudioBuffer to a 16-bit PCM RIFF blob and `downloadBlob` hands it
 * to the browser. The mix render itself lives on the engine
 * (`engine.renderCurrentState`).
 */

/** Serialise an AudioBuffer to a WAV (RIFF) file as a Blob. */
export function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels
  const sampleRate = buffer.sampleRate
  const numFrames = buffer.length
  const bitsPerSample = 16
  const blockAlign = (numChannels * bitsPerSample) / 8
  const dataSize = numFrames * blockAlign
  const headerSize = 44

  const out = new ArrayBuffer(headerSize + dataSize)
  const view = new DataView(out)

  // RIFF chunk
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(view, 8, 'WAVE')
  // fmt subchunk
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // subchunk1 size (PCM)
  view.setUint16(20, 1, true) // audio format (1 = PCM)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  // data subchunk
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  // Interleaved Int16
  const channelData: Array<Float32Array> = []
  for (let c = 0; c < numChannels; c++)
    channelData.push(buffer.getChannelData(c))

  let off = headerSize
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const sample = Math.max(-1, Math.min(1, channelData[c]![i]!))
      const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      view.setInt16(off, int16 | 0, true)
      off += 2
    }
  }

  return new Blob([out], { type: 'audio/wav' })
}

function writeAscii(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++)
    view.setUint8(offset + i, str.charCodeAt(i))
}

/** Trigger a browser download for a Blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, 0)
}
