import { useEffect, useRef, useState, type RefObject } from "react";
import { createEntryImageCache, entryImageHref } from "../../../packages/client/src/entry-images";
import type { EntryImage, EntryImageSize } from "../../../packages/shared/src/entry-images";
import { api, errorMessage } from "./api";
import { Icon } from "./icons";
import { ImageView } from "./session-files";
import { Alert, Button, Sheet, Spinner } from "./ui";

/*
 * A transcript entry's images (entry-images.ts in packages/client): a thumbnail for each, read from the host as it
 * scrolls into view, and the whole image in a sheet when it is pressed.
 */

const cache = createEntryImageCache(href => api<{ image: EntryImage }>(href));

/** The image at `href` as a data: URL once loaded (null: not yet asked for), or why it couldn't be. */
function useEntryImage(href: string | null) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ source?: string; error?: string }>(() => ({ source: href ? cache.loaded(href) : undefined }));
  useEffect(() => {
    if (!href) return;
    const loaded = cache.loaded(href);
    if (loaded) { setState({ source: loaded }); return; }
    let current = true;
    setState({});
    cache.get(href).then(source => { if (current) setState({ source }); }, error => { if (current) setState({ error: errorMessage(error) }); });
    return () => { current = false; };
  }, [href, attempt]);
  return { ...state, retry: () => setAttempt(value => value + 1) };
}

/** Whether `ref`'s element has come near the visible part of the page; once it has, it stays so. */
function useSeen(ref: RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (seen || !element) return;
    if (typeof IntersectionObserver === "undefined") { setSeen(true); return; }
    const observer = new IntersectionObserver(items => { if (items.some(item => item.isIntersecting)) setSeen(true); }, { rootMargin: "400px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, seen]);
  return seen;
}

const href = (sessionId: string, entryId: string, index: number, size: EntryImageSize) => entryImageHref(sessionId, entryId, index, size);

/** Thumbnails of the images an entry gave the model, in its order; pressing one shows it whole. */
export function EntryImages({ sessionId, entryId, images }: { sessionId: string; entryId: string; images: { mimeType: string }[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!images.length) return null;
  return <>
    <ul className="entry-images" aria-label={images.length === 1 ? "Image" : `${images.length} images`}>
      {images.map((image, index) => <li key={index}>
        <Thumbnail href={href(sessionId, entryId, index, "thumbnail")} label={`Image ${index + 1} (${image.mimeType})`} onOpen={() => setOpen(index)} />
      </li>)}
    </ul>
    <Sheet open={open !== null} wide title={images.length === 1 ? "Image" : `Image ${(open ?? 0) + 1} of ${images.length}`} onClose={() => setOpen(null)}
      footer={images.length > 1 && open !== null ? <>
        <Button variant="secondary" size="sm" icon="chevron-left" disabled={open === 0} onClick={() => setOpen(open - 1)}>Previous</Button>
        <Button variant="secondary" size="sm" icon="chevron-right" disabled={open === images.length - 1} onClick={() => setOpen(open + 1)}>Next</Button>
      </> : undefined}>
      {open !== null && <WholeImage key={open} href={href(sessionId, entryId, open, "full")} label={`Image ${open + 1}`} />}
    </Sheet>
  </>;
}

function Thumbnail({ href, label, onOpen }: { href: string; label: string; onOpen: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const seen = useSeen(ref);
  const image = useEntryImage(seen ? href : null);
  if (image.error) {
    return <button ref={ref} type="button" className="entry-image failed" onClick={image.retry} title={`${image.error} Press to try again.`} aria-label={`${label}: can't be shown. Try again`}>
      <Icon name="image" size={20} /><span className="small">Can't show</span>
    </button>;
  }
  return <button ref={ref} type="button" className={image.source ? "entry-image" : "entry-image loading"} onClick={onOpen} title="Show the whole image" aria-label={`${label}: show it whole`}>
    {image.source ? <img src={image.source} alt={label} draggable={false} /> : <Icon name="image" size={20} />}
  </button>;
}

function WholeImage({ href, label }: { href: string; label: string }) {
  const image = useEntryImage(href);
  if (image.error) {
    return <Alert variant="error" title="Can't show this image" actions={<Button variant="outline" size="sm" icon="refresh" onClick={image.retry}>Try again</Button>}>{image.error}</Alert>;
  }
  if (!image.source) return <div className="entry-image-loading"><Spinner />Loading image...</div>;
  return <ImageView src={image.source} path={label} />;
}
