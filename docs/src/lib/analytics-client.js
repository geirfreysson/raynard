import {pageViewFields} from './analytics';

const analyticsClient = {
  onRouteDidUpdate({location, previousLocation}) {
    if (!previousLocation) return;
    if (location.pathname === previousLocation.pathname && location.search === previousLocation.search) return;

    // Shared answers live in the fragment. Never send that payload to Google
    // Analytics, either here or in the initial config in docusaurus.config.js.
    setTimeout(() => {
      if (typeof window.gtag !== 'function') return;
      window.gtag('event', 'page_view', {
        ...pageViewFields(window.location),
        page_title: document.title,
      });
    });
  },
};

export default analyticsClient;
