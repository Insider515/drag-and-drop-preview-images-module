/**
 * Minimal DOM helpers.
 *
 * There is no `html:` escape hatch on purpose. This widget renders file names
 * the user picked, and the version of it that concatenated strings into
 * `innerHTML` is exactly where that becomes a scripting hole. Building nodes
 * and setting `textContent` cannot be made unsafe by a file called
 * `<img onerror=...>.png`.
 */

/**
 * Create an element.
 * @param {string} tag tag name, optionally with `.class.names`
 * @param {object} [attrs] properties; `class`, `dataset`, `style`, `on` and
 *   `text` get special handling, everything else becomes an attribute
 * @param {Array<Node|string|null|undefined>} [children]
 */
export function el(tag, attrs = {}, children = []) {
  const [tagName, ...classes] = tag.split('.');
  const node = document.createElement(tagName || 'div');
  if (classes.length) node.classList.add(...classes);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') {
      node.classList.add(...String(value).split(/\s+/).filter(Boolean));
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (key === 'style') {
      Object.assign(node.style, value);
    } else if (key === 'on') {
      for (const [event, handler] of Object.entries(value)) {
        node.addEventListener(event, handler);
      }
    } else if (key in node && key !== 'list' && key !== 'form') {
      node[key] = value;
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }

  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Remove every child of a node. */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}
