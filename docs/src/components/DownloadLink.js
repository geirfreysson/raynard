import Link from '@docusaurus/Link';
import {trackDownloadClick} from '../lib/analytics';

export default function DownloadLink({platform, url, children}) {
  return (
    <Link
      to={url}
      onClick={() => trackDownloadClick({
        platform,
        placement: 'getting_started',
        url,
        label: typeof children === 'string' ? children.trim() : platform,
      })}
    >
      {children}
    </Link>
  );
}
