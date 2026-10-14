import { StrictMode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { createRoot } from 'react-dom/client';
import { vi } from '@mihato/i18n';
import { router } from './app/router';
import { queryClient } from './lib/query';
import './styles.css';

document.title = vi.common.appName;

const container = document.getElementById('root');
if (!container) throw new Error('Thiếu phần tử #root trong index.html');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
