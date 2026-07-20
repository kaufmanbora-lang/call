'use strict';

(function installDisclosureModule() {
  const NOTICE_TEXT = 'Набор виден оператору в реальном времени';

  function createDisclosure(container) {
    if (!(container instanceof HTMLElement)) {
      return Object.freeze({ installed: false, setVisible() {} });
    }

    const notice = document.createElement('p');
    notice.id = 'sharingNotice';
    notice.className = 'sharing-notice';
    notice.textContent = NOTICE_TEXT;
    notice.hidden = true;
    container.append(notice);

    return Object.freeze({
      installed: true,
      setVisible(visible) {
        notice.hidden = !visible;
      }
    });
  }

  window.PhoneDisclosure = Object.freeze({ createDisclosure });
})();
