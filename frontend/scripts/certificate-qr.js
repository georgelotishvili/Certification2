/* Certificate profile QR. Requires the local vendor/qrcode-generator.js encoder. */
(function (global) {
  'use strict';

  const PROFILE_URL = 'https://gipc.org.ge/pages/my.html?code=';
  const QUIET_ZONE = 4;
  const ERROR_CORRECTION = 'Q';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ACCESSIBLE_LABEL = 'სერტიფიკატის მფლობელის საჯარო გვერდი';

  function buildProfileUrl(code) {
    // User.code is the permanent certification identifier, not the reusable
    // database user ID or editable certificate metadata. Keep leading zeroes.
    if (typeof code !== 'string' || code.length !== 10 || !/^[0-9]{10}$/.test(code)) {
      throw new TypeError('A 10-digit permanent certification code string is required for the certificate QR.');
    }
    return PROFILE_URL + code;
  }

  function buildMatrix(code) {
    const url = buildProfileUrl(code);
    if (typeof global.qrcode !== 'function') {
      throw new Error('The local certificate QR encoder is unavailable.');
    }
    // Auto-select the QR version. Only the public URL is encoded, never profile data.
    const qr = global.qrcode(0, ERROR_CORRECTION);
    qr.addData(url, 'Byte');
    qr.make();
    const moduleCount = qr.getModuleCount();
    const modules = Array.from({ length: moduleCount }, (_, row) =>
      Array.from({ length: moduleCount }, (_, col) => qr.isDark(row, col)));
    return { url, moduleCount, modules, quietZone: QUIET_ZONE, errorCorrectionLevel: ERROR_CORRECTION };
  }

  function createSvg(code, options = {}) {
    const matrix = buildMatrix(code);
    const doc = options.document || global.document;
    if (!doc || typeof doc.createElementNS !== 'function') {
      throw new Error('An SVG-capable document is required for the certificate QR.');
    }
    const side = matrix.moduleCount + 2 * QUIET_ZONE;
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('xmlns', SVG_NS);
    svg.setAttribute('viewBox', `0 0 ${side} ${side}`);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', ACCESSIBLE_LABEL);
    svg.setAttribute('focusable', 'false');

    const title = doc.createElementNS(SVG_NS, 'title');
    title.textContent = ACCESSIBLE_LABEL;
    svg.appendChild(title);

    // The quiet zone is part of the SVG itself, so printing cannot trim it away.
    const background = doc.createElementNS(SVG_NS, 'rect');
    background.setAttribute('width', String(side));
    background.setAttribute('height', String(side));
    background.setAttribute('fill', '#fff');
    svg.appendChild(background);

    const paths = [];
    for (let row = 0; row < matrix.moduleCount; row += 1) {
      for (let col = 0; col < matrix.moduleCount; col += 1) {
        if (!matrix.modules[row][col]) continue;
        const start = col;
        while (col + 1 < matrix.moduleCount && matrix.modules[row][col + 1]) col += 1;
        const length = col - start + 1;
        paths.push(`M${start + QUIET_ZONE},${row + QUIET_ZONE}h${length}v1h-${length}z`);
      }
    }
    const foreground = doc.createElementNS(SVG_NS, 'path');
    foreground.setAttribute('fill', '#000');
    foreground.setAttribute('d', paths.join(''));
    svg.appendChild(foreground);
    return svg;
  }

  global.CertificateQR = Object.freeze({ buildProfileUrl, buildMatrix, createSvg });
})(typeof window !== 'undefined' ? window : globalThis);
