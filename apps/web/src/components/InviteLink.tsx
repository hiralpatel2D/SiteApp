import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { labelClass, secondaryButton } from './ui';

type Props = {
  url: string;
  /** What the link is for, shown above it. */
  children: ReactNode;
  /** The WhatsApp message; the link is appended. */
  shareText: string;
};

/** A fresh invite link with Copy and Share on WhatsApp (email is not sent yet). */
export function InviteLink({ url, children, shareText }: Props) {
  const linkRef = useRef<HTMLParagraphElement>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'manual'>('idle');

  function selectLink() {
    const el = linkRef.current;
    const sel = window.getSelection();
    if (!el || !sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(url);
      setCopyState('copied');
    } catch {
      // No clipboard access: select the text so it can be copied by hand.
      selectLink();
      setCopyState('manual');
    }
  }

  const whatsapp = `https://wa.me/?text=${encodeURIComponent(`${shareText} ${url}`)}`;

  return (
    <div className="flex animate-[rise_.4s_var(--spring)_both] flex-col gap-3 rounded-[var(--r)] border border-line bg-card px-4 py-4">
      <div className="break-words">{children}</div>
      <span className={labelClass}>Invite link</span>
      <p
        ref={linkRef}
        data-testid="invite-link"
        className="select-all break-all rounded-[calc(var(--r)*0.75)] border border-field-line bg-surface px-3 py-2.5 font-mono text-[13px]"
      >
        {url}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void copy()} className={secondaryButton}>
          Copy link
        </button>
        <a href={whatsapp} target="_blank" rel="noopener noreferrer" className={secondaryButton}>
          Share on WhatsApp
        </a>
        <span role="status" className="text-muted">
          {copyState === 'copied'
            ? 'Link copied.'
            : copyState === 'manual'
              ? 'Link selected. Copy it from your device menu.'
              : ''}
        </span>
      </div>
    </div>
  );
}
