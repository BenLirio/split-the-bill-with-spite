(function () {
  var ENDPOINT = 'https://5c99bazuj0.execute-api.us-east-1.amazonaws.com/feedback';

  function detectSlug() {
    var seg = location.pathname.split('/').filter(Boolean);
    return (seg[0] || 'unknown').toLowerCase();
  }

  var CSS = ''
    + '.ef-fb-btn{position:fixed;right:12px;bottom:12px;z-index:2147483000;'
    + 'background:#111;color:#fff;border:2px solid #fff;padding:10px 14px;'
    + 'font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;'
    + 'letter-spacing:.04em;text-transform:uppercase;cursor:pointer;'
    + 'border-radius:999px;box-shadow:0 2px 8px rgba(0,0,0,.25)}'
    + '.ef-fb-btn:hover{background:#fff;color:#111}'
    + '.ef-fb-overlay{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.55);'
    + 'display:none;align-items:center;justify-content:center;padding:16px}'
    + '.ef-fb-overlay.open{display:flex}'
    + '.ef-fb-modal{background:#fff;color:#111;width:100%;max-width:420px;padding:20px;'
    + 'border-radius:8px;font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;'
    + 'box-shadow:0 20px 60px rgba(0,0,0,.35)}'
    + '.ef-fb-modal h3{margin:0 0 6px;font-size:16px}'
    + '.ef-fb-modal p{margin:0 0 12px;font-size:13px;color:#555}'
    + '.ef-fb-modal textarea{width:100%;min-height:110px;padding:10px;border:1px solid #ccc;'
    + 'border-radius:4px;font:inherit;resize:vertical;box-sizing:border-box}'
    + '.ef-fb-row{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}'
    + '.ef-fb-row button{padding:9px 14px;border:1px solid #111;background:#fff;color:#111;'
    + 'cursor:pointer;font:inherit;border-radius:4px}'
    + '.ef-fb-row button.primary{background:#111;color:#fff}'
    + '.ef-fb-row button[disabled]{opacity:.5;cursor:default}'
    + '.ef-fb-status{font-size:12px;color:#555;margin-top:8px;min-height:1em}';

  function mount() {
    if (document.getElementById('ef-fb-style')) return;
    var style = document.createElement('style');
    style.id = 'ef-fb-style';
    style.textContent = CSS;
    document.head.appendChild(style);

    var btn = document.createElement('button');
    btn.className = 'ef-fb-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Send feedback');
    btn.textContent = 'Feedback';

    var overlay = document.createElement('div');
    overlay.className = 'ef-fb-overlay';
    overlay.innerHTML = ''
      + '<div class="ef-fb-modal" role="dialog" aria-labelledby="ef-fb-title">'
      + '<h3 id="ef-fb-title">Send feedback</h3>'
      + '<p>What worked, what broke, what would make this better?</p>'
      + '<textarea maxlength="2000" placeholder="Type anything..."></textarea>'
      + '<div class="ef-fb-status"></div>'
      + '<div class="ef-fb-row">'
      + '<button type="button" class="ef-fb-cancel">Cancel</button>'
      + '<button type="button" class="primary ef-fb-send">Send</button>'
      + '</div></div>';

    document.body.appendChild(btn);
    document.body.appendChild(overlay);

    var textarea = overlay.querySelector('textarea');
    var status = overlay.querySelector('.ef-fb-status');
    var sendBtn = overlay.querySelector('.ef-fb-send');
    var cancelBtn = overlay.querySelector('.ef-fb-cancel');

    function open() {
      overlay.classList.add('open');
      status.textContent = '';
      setTimeout(function () { textarea.focus(); }, 30);
    }
    function close() {
      overlay.classList.remove('open');
    }
    function reset() {
      textarea.value = '';
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';
    }

    btn.addEventListener('click', open);
    cancelBtn.addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });

    sendBtn.addEventListener('click', function () {
      var text = textarea.value.trim();
      if (!text) {
        status.textContent = 'Add a note first.';
        return;
      }
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending...';
      status.textContent = '';

      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: detectSlug(), text: text })
      }).then(function (r) {
        if (!r.ok) throw new Error('http_' + r.status);
        return r.json();
      }).then(function () {
        status.textContent = 'Thanks — got it.';
        setTimeout(function () { close(); reset(); }, 1200);
      }).catch(function () {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Retry';
        status.textContent = 'Send failed. Try again?';
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
