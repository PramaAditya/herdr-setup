import { run, setShared } from "herdr";

function pathToFileUrl(filePath) {
  const norm = String(filePath).replace(/\\/g, "/");
  const encoded = norm
    .split("/")
    .map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join("/");
  return encoded.startsWith("/") ? `file://${encoded}` : `file:///${encoded}`;
}

export function handleLink(click) {
  const link = click?.link;
  if (!link) return "pass";

  let payload = null;
  if (link.kind === "url" && link.url) {
    payload = { url: link.url, newTab: true, ts: Date.now() };
  } else if (link.kind === "file" && link.path) {
    payload = {
      path: link.path,
      url: pathToFileUrl(link.path),
      newTab: true,
      ts: Date.now(),
    };
  }

  if (!payload) return "pass";

  setShared("browser.navigate", payload);
  run("layout.select", { stack: "panel-body", child: "browser" });
  run("layout.show", { id: "panel" });
  return "handled";
}
