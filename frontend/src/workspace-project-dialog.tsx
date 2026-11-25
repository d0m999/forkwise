import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';

export function WorkspaceProjectDialog({ dialog, label, dismiss, children }: {
  dialog: RefObject<HTMLDialogElement | null>;
  label: string;
  dismiss: () => void;
  children: ReactNode;
}) {
  const composing = useRef(false);
  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, [dialog]);

  return <dialog ref={dialog} className="workspace-project-dialog" aria-label={label}
    onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={() => { composing.current = false; }}
    onCancel={event => { event.preventDefault(); if (!composing.current) dismiss(); }}>
    {children}
  </dialog>;
}
