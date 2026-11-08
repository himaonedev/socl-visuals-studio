import { render, screen } from '@testing-library/react';
import { TopBar } from '../editor/components/layout/TopBar';
import { MediaLibrary } from '../editor/components/layout/MediaLibrary';
import { TooltipProvider } from '../editor/components/ui/tooltip';
import { useProjectStore } from '../editor/store/project';
import { useWorkspaceStore } from '../editor/store/workspace';
import { useUiStore } from '../editor/store/ui';

it('keeps general media import and export actions out of the clip-bound Effects toolbar', () => {
  useProjectStore.getState().newProject('SOCL clip');
  useWorkspaceStore.setState({ mode: 'effects', clipBound: true });
  useUiStore.getState().setSidePanel('library');
  render(<TooltipProvider><TopBar /><MediaLibrary /></TooltipProvider>);
  expect(screen.queryByRole('button', { name: 'Import media' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Export' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'File menu' })).not.toBeInTheDocument();
  expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  expect(screen.queryByText('Export subtitles (.srt)…')).not.toBeInTheDocument();
  expect(screen.queryByText('Import subtitles (.srt)…')).not.toBeInTheDocument();
});
