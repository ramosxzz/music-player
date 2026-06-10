(function () {
  const MOBILE_QUERY = '(max-width: 760px)';
  const mobileMatcher = window.matchMedia(MOBILE_QUERY);
  const currentFile = (window.location.pathname.split('/').pop() || 'index.html').toLowerCase();
  const isMobile = mobileMatcher.matches;

  const routeMap = {
    'index.html': isMobile ? 'mobile.html' : null,
    'index': isMobile ? 'mobile.html' : null,
    '': isMobile ? 'mobile.html' : null,
    'mobile.html': isMobile ? null : 'index.html',
    'mobile': isMobile ? null : 'index.html',
    'room.html': isMobile ? 'room-mobile.html' : null,
    'room': isMobile ? 'room-mobile.html' : null,
    'room-mobile.html': isMobile ? null : 'room.html',
    'room-mobile': isMobile ? null : 'room.html',
  };

  const nextFile = routeMap[currentFile];
  if (!nextFile) return;

  window.location.replace(`/${nextFile}${window.location.search}${window.location.hash}`);
})();
