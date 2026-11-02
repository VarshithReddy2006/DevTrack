import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmationModal } from './ConfirmationModal';
import { Drawer } from './Drawer';
import { Modal } from './Modal';
import { CreateProjectModal } from '../../pages/ProjectsPage';
import { TaskDetailDrawer } from '../../features/projects/components/TaskDetailDrawer';
import type { ProjectTaskVM } from '../../types/vm.types';

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
});

function ConfirmationHarness({ onConfirm }: { onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setOpen(true)}>Delete item</button>
    <ConfirmationModal isOpen={open} title="Delete item?" message="This cannot be undone." type="danger" onConfirm={onConfirm} onCancel={() => setOpen(false)} />
  </>;
}

describe('dialog keyboard accessibility', () => {
  it('names a destructive confirmation, traps focus, and restores the opener after Escape', async () => {
    const confirm = vi.fn();
    render(<ConfirmationHarness onConfirm={confirm} />);
    const opener = screen.getByRole('button', { name: 'Delete item' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('alertdialog', { name: 'Delete item?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.body.style.overflow).toBe('hidden');

    screen.getByRole('button', { name: 'Close modal' }).focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Confirm' }));
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close modal' }));
    opener.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(document.body.style.overflow).toBe('');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('lets only the top dialog close and returns focus through a stacked drawer', async () => {
    function Stacked() {
      const [modalOpen, setModalOpen] = useState(false);
      const [drawerOpen, setDrawerOpen] = useState(false);
      return <>
        <button onClick={() => setModalOpen(true)}>Open settings</button>
        <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Settings" description="Configure settings">
          <button onClick={() => setDrawerOpen(true)}>Open details</button>
        </Modal>
        <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Details">
          <button>Drawer action</button>
        </Drawer>
      </>;
    }

    render(<Stacked />);
    const opener = screen.getByRole('button', { name: 'Open settings' });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    const details = screen.getByRole('button', { name: 'Open details' });
    details.focus();
    fireEvent.click(details);
    expect(screen.getByRole('dialog', { name: 'Details' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(details));
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(document.body.style.overflow).toBe('');
  });

  it('focuses the project name and names the create-project dialog and close control', async () => {
    function CreateHarness() {
      const [open, setOpen] = useState(false);
      return <>
        <button onClick={() => setOpen(true)}>New Project</button>
        <CreateProjectModal open={open} onClose={() => setOpen(false)} onCreate={vi.fn()} />
      </>;
    }
    render(<CreateHarness />);
    const opener = screen.getByRole('button', { name: 'New Project' });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole('dialog', { name: 'New Project' }).getAttribute('aria-modal')).toBe('true');
    expect(screen.getByRole('button', { name: 'Close new project dialog' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByPlaceholderText('My awesome project...'));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('closes only the task editor when nested inside a project dialog', async () => {
    const task: ProjectTaskVM = {
      id: 'task-1', title: 'Review PR', description: '', statusLabel: 'To Do', statusColor: '', statusIcon: '',
      priorityLabel: 'Medium', priorityColor: '', priorityIcon: '', labels: [], assignee: null,
      dueDate: null, isOverdue: false,
    };
    function TaskHarness() {
      const [projectOpen, setProjectOpen] = useState(false);
      const [editing, setEditing] = useState(false);
      return <>
        <button onClick={() => setProjectOpen(true)}>Open project</button>
        <Modal open={projectOpen} onClose={() => setProjectOpen(false)} title="Project details">
          <button onClick={() => setEditing(true)}>Edit task</button>
          <TaskDetailDrawer task={editing ? task : null} projectId="project-1" onClose={() => setEditing(false)} onUpdated={vi.fn()} />
        </Modal>
      </>;
    }
    render(<TaskHarness />);
    const projectOpener = screen.getByRole('button', { name: 'Open project' });
    projectOpener.focus();
    fireEvent.click(projectOpener);
    const taskOpener = screen.getByRole('button', { name: 'Edit task' });
    taskOpener.focus();
    fireEvent.click(taskOpener);
    expect(screen.getByRole('dialog', { name: 'Edit Task' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByPlaceholderText('Task title...'));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(taskOpener));
    expect(screen.getByRole('dialog', { name: 'Project details' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(projectOpener));
  });
});
