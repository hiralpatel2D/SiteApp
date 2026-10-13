import { createFileRoute } from '@tanstack/react-router';
import { SignIn } from '../components/SignIn';

export const Route = createFileRoute('/')({ component: SignIn });
