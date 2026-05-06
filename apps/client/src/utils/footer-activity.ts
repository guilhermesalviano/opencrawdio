type FooterActivity = 'heartbeat' | 'summarizer';
type FooterActivityListener = (note: string) => void;

const ACTIVITY_LABELS: Record<FooterActivity, string> = {
  heartbeat: 'heartbeat',
  summarizer: 'summarizer',
};

const ACTIVITY_ORDER: FooterActivity[] = ['heartbeat', 'summarizer'];

class FooterActivityStore {
  private counts = new Map<FooterActivity, number>();
  private listeners = new Set<FooterActivityListener>();

  begin(activity: FooterActivity): () => void {
    this.counts.set(activity, (this.counts.get(activity) ?? 0) + 1);
    this.emit();

    let ended = false;
    return () => {
      if (ended) return;
      ended = true;

      const current = this.counts.get(activity) ?? 0;
      if (current <= 1) this.counts.delete(activity);
      else this.counts.set(activity, current - 1);

      this.emit();
    };
  }

  subscribe(listener: FooterActivityListener): () => void {
    this.listeners.add(listener);
    listener(this.getNote());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getNote(): string {
    const active = ACTIVITY_ORDER
      .filter((activity) => (this.counts.get(activity) ?? 0) > 0)
      .map((activity) => ACTIVITY_LABELS[activity]);

    if (active.length === 0) return '';

    return `background: ${active.join(', ')}`;
  }

  reset(): void {
    this.counts.clear();
    this.emit();
  }

  private emit(): void {
    const note = this.getNote();
    for (const listener of this.listeners) {
      listener(note);
    }
  }
}

const footerActivityStore = new FooterActivityStore();

function beginFooterActivity(activity: FooterActivity): () => void {
  return footerActivityStore.begin(activity);
}

function subscribeToFooterActivity(listener: FooterActivityListener): () => void {
  return footerActivityStore.subscribe(listener);
}

function getFooterActivityNote(): string {
  return footerActivityStore.getNote();
}

function resetFooterActivityStore(): void {
  footerActivityStore.reset();
}

export {
  beginFooterActivity,
  getFooterActivityNote,
  resetFooterActivityStore,
  subscribeToFooterActivity,
};
