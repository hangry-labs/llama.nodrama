"use strict";

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  /* parser already past DOMContentLoaded — schedule on the next tick so
   * any synchronous code below this point still runs first. */
  Promise.resolve().then(boot);
}

