// The script of both pages. Every two seconds it reads the data endpoint of the page's
// address (KTD14), the view of a component or the list of the index's components, and puts
// on the page what `render.ts` draws for each answer. It adds no data of its own: a page
// shows the endpoint's JSON and the time it was read.
//
// A drawing becomes the document through `createElement` and `createTextNode` alone, so
// a value from a record or a registration is set as text and never parsed as markup.
//
// It also puts the map of `map.ts` behind the page. The map is decoration and holds no
// data.

import { ground } from "./map.ts";
import { NOTHING_READ, draw, placeOf, readOf } from "./render.ts";
import type { Drawing, Drawn } from "./render.ts";

/** A page reads its endpoint this often (KTD14). */
const POLL_MS = 2000;
/** One read may take this long. A read that has not ended by then counts as failed, so an answer that never comes cannot stop the reading. */
const READ_MS = 10_000;

function build(drawing: Drawing | string): Node {
  if (typeof drawing === "string") return document.createTextNode(drawing);
  const element = document.createElement(drawing.tag);
  for (const [name, value] of Object.entries(drawing.attributes)) element.setAttribute(name, value);
  element.append(...drawing.children.map(build));
  return element;
}

ground();

const place = placeOf(location.pathname, location.search);
const view = document.getElementById("view");

if (place !== undefined && view !== null) {
  let held = NOTHING_READ;

  const show = (drawn: Drawn): void => {
    // With no body the view on screen is the one just read, or the last one that could be.
    if (drawn.body !== undefined) view.replaceChildren(build(drawn.body));
    document.getElementById("status")?.replaceWith(build(drawn.status));
    held = drawn.held;
  };

  const poll = async (): Promise<void> => {
    try {
      // The limit covers the answer's body too: reading it ends with the same signal.
      const response = await fetch(place.viewPath, { cache: "no-store", signal: AbortSignal.timeout(READ_MS) });
      show(draw(place, held, readOf(await response.json()), Date.now()));
    } catch {
      // No answer, an answer past its time, an answer that is no JSON, or one that could not be drawn: the last drawing stays.
      show(draw(place, held, { kind: "failed" }, Date.now()));
    } finally {
      // The next read is set whatever came of this one, so the page never stops reading without a word.
      setTimeout(() => void poll(), POLL_MS);
    }
  };

  void poll();
}
