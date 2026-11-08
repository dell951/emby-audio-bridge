// Codec names reported by FFmpeg's demuxer (DTS-HD is reported as dts).
export function needsAudioBridge(codec) {
  return ['ac3', 'eac3', 'dts'].includes(codec);
}
