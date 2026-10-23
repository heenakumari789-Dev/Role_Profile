'use strict';
const path = require('path');
const ejs = require('ejs');

const LAYOUT = path.join(__dirname, '..', 'views', 'partials', 'layout.ejs');

/**
 * Render a page inside the shared layout. EJS has no template inheritance, so the page
 * is rendered first and injected as `body` — the same shape as the PHP layout's section.
 */
function attach(app) {
  app.use((req, res, next) => {
    res.page = async (view, data = {}) => {
      const locals = { ...res.locals, ...data };
      try {
        const body = await ejs.renderFile(
          path.join(app.get('views'), `${view}.ejs`),
          locals,
          { async: true }
        );
        const html = await ejs.renderFile(LAYOUT, { ...locals, body }, { async: true });
        res.send(html);
      } catch (err) {
        next(err);
      }
    };
    next();
  });
}

module.exports = { attach };
