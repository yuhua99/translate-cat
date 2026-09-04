export function parseYouTubeVideoId(url: URL): string | null {
  if (url.pathname === '/watch') return url.searchParams.get('v') || null

  return url.pathname.match(/^\/live\/([A-Za-z0-9_-]+)(?:\/|$)/)?.[1] ?? null
}

function isVideoPage(): boolean {
  return parseYouTubeVideoId(new URL(location.href)) !== null
}

function isMainVideo(video: HTMLVideoElement): boolean {
  return video.classList.contains('html5-main-video')
}

export function listenForMainVideoLoads(callback: () => void): void {
  document.addEventListener(
    'loadstart',
    (event) => {
      if (!isVideoPage()) return
      if (event.target instanceof HTMLVideoElement && isMainVideo(event.target)) callback()
    },
    true,
  )

  if (isVideoPage() && document.querySelector('video.html5-main-video')) callback()
}
