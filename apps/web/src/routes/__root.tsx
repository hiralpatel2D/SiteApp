import { Outlet, createRootRoute } from '@tanstack/react-router';
import { ThemeProvider } from '../theme/ThemeProvider';

export const Route = createRootRoute({
  component: () => (
    <ThemeProvider>
      <Outlet />
    </ThemeProvider>
  ),
});
