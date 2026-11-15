// Lucide outlines: play, pause, loader-circle, rotate-cw, image.
// Semantics below follow the existing inline CardIcon convention; attribution:
// prototype/open-canvas-r2-20261011/vendor/LICENSE-lucide.txt.
// Source blobs are fixed in this issue's private icon input evidence.
export function GifToggle({ className }: { className?: string }) {
  const icons = {
    play: <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />,
    pause: <><rect x="14" y="3" width="5" height="18" rx="1" /><rect x="5" y="3" width="5" height="18" rx="1" /></>,
    loading: <path d="M21 12a9 9 0 1 1-6.219-8.56" />,
    retry: <><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /></>,
    still: <><rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" /></>,
  };
  return <button type="button" data-gif-toggle="" data-gif-state="play" aria-label="播放动图" className={['gif-toggle', className].filter(Boolean).join(' ')}
    onClick={event => event.stopPropagation()}>
    {Object.entries(icons).map(([state, paths]) => <svg key={state} data-gif-icon={state} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths}</svg>)}
    <span data-gif-label="">播放动图</span>
  </button>;
}
