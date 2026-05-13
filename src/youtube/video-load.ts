export function isWatchPage(): boolean {
  return location.pathname === '/watch' && new URL(location.href).searchParams.has('v')
}

function isMainVideo(video: HTMLVideoElement): boolean {
  return video.classList.contains('html5-main-video')
}

export function listenForMainVideoLoads(callback: () => void): void {
  document.addEventListener(
    'loadstart',
    (event) => {
      if (!isWatchPage()) return
      if (event.target instanceof HTMLVideoElement && isMainVideo(event.target)) callback()
    },
    true,
  )

  if (isWatchPage() && document.querySelector('video.html5-main-video')) callback()
}
