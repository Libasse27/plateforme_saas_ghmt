import { describe, expect, it } from 'vitest';
import { BackgroundTasks } from './background-tasks';

describe('BackgroundTasks', () => {
  it('rend la main avant d’exécuter la tâche, puis drain() attend sa fin', async () => {
    const tasks = new BackgroundTasks();
    const events: string[] = [];
    tasks.run('essai', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push('tâche');
    });
    events.push('appelant');
    await tasks.drain();
    expect(events).toEqual(['appelant', 'tâche']);
  });

  it('absorbe les erreurs d’une tâche sans empêcher les suivantes', async () => {
    const tasks = new BackgroundTasks();
    let done = false;
    tasks.run('échec', () => Promise.reject(new Error('secret=abc')));
    tasks.run('suite', () => {
      done = true;
      return Promise.resolve();
    });
    await expect(tasks.drain()).resolves.toBeUndefined();
    expect(done).toBe(true);
  });

  it('drain() attend aussi les tâches lancées par une tâche', async () => {
    const tasks = new BackgroundTasks();
    let nested = false;
    tasks.run('parent', () => {
      tasks.run('enfant', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        nested = true;
      });
      return Promise.resolve();
    });
    await tasks.drain();
    expect(nested).toBe(true);
  });
});
