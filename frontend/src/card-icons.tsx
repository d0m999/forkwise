// Lucide outlines, ISC/MIT attribution retained in prototype/open-canvas-r2-20261011/vendor/LICENSE-lucide.txt.
export function CardIcon({
  name,
}: {
  name: "写字板" | "外观" | "AI" | "更多" | "关闭";
}) {
  const paths = {
    写字板: (
      <>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
        <path d="M14 2v6h6M8 13h8M8 17h6" />
      </>
    ),
    外观: (
      <>
        <circle cx="13.5" cy="6.5" r=".5" />
        <circle cx="17.5" cy="10.5" r=".5" />
        <circle cx="8.5" cy="7.5" r=".5" />
        <circle cx="6.5" cy="12.5" r=".5" />
        <path d="M12 22a10 10 0 1 1 10-10 3 3 0 0 1-3 3h-1.8a1.2 1.2 0 0 0-.8 2.1 2.8 2.8 0 0 1 .8 1.9 3 3 0 0 1-3 3Z" />
      </>
    ),
    AI: <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" />,
    更多: (
      <>
        <circle cx="5" cy="12" r="1" />
        <circle cx="12" cy="12" r="1" />
        <circle cx="19" cy="12" r="1" />
      </>
    ),
    关闭: <path d="m6 6 12 12M6 18 18 6" />,
  };
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
