import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
	title: 'Canvas OG cards demo',
	description:
		'Next.js 14 example using @canvas-images/sdk to render dynamic OG images per blog post.'
};

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<body
				style={{
					fontFamily:
						'-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
					margin: 0,
					padding: '2rem',
					maxWidth: '720px',
					marginLeft: 'auto',
					marginRight: 'auto',
					color: '#1a1a1a',
					lineHeight: 1.6
				}}
			>
				{children}
			</body>
		</html>
	);
}
