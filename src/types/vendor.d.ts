declare module 'ffprobe-static' {
  const ffprobe: { path: string; version?: string };
  export = ffprobe;
}

declare module 'ffmpeg-static' {
  const ffmpegPath: string | null;
  export default ffmpegPath;
}
