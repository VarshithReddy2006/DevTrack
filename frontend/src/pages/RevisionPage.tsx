import { Link } from 'react-router-dom';
import { PageShell } from '../components/layout/PageShell';
import { RevisionReviewDeck } from '../features/revision/components/RevisionReviewDeck';

export default function RevisionPage() {
  return (
    <PageShell title="Revision Radar" subtitle="Recall, rate, repeat." status="success" error={null} actions={<Link to="/dsa" className="dt-btn dt-btn-secondary dt-btn-sm">Back to DSA</Link>}>
      <RevisionReviewDeck />
    </PageShell>
  );
}
