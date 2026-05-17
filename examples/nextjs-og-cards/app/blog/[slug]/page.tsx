import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { client } from '@/lib/client';
import { getPost, posts } from '@/lib/posts';

interface BlogPostParams {
	params: { slug: string };
}

/**
 * Per-post `generateMetadata` — this is the canonical Next.js
 * pattern for dynamic OG images. The crawler picks up
 * `openGraph.images` and fetches the Canvas Render API directly;
 * the Next.js app never proxies the bytes.
 */
export function generateMetadata({ params }: BlogPostParams): Metadata {
	const post = getPost(params.slug);
	if (!post) return {};

	const ogImage = client.image('og-card', {
		title: post.title,
		subtitle: post.subtitle
	});

	return {
		title: post.title,
		description: post.subtitle,
		openGraph: {
			title: post.title,
			description: post.subtitle,
			images: [{ url: ogImage, width: 1200, height: 630 }]
		},
		twitter: {
			card: 'summary_large_image',
			title: post.title,
			description: post.subtitle,
			images: [ogImage]
		}
	};
}

/** Static-params hook — pre-renders the three fixture posts at build time. */
export function generateStaticParams() {
	return posts.map((post) => ({ slug: post.slug }));
}

export default function BlogPost({ params }: BlogPostParams) {
	const post = getPost(params.slug);
	if (!post) notFound();

	return (
		<main>
			<p>
				<Link href="/" style={{ color: '#0070f3' }}>
					← Back
				</Link>
			</p>
			<h1>{post.title}</h1>
			<p style={{ color: '#666', marginTop: '-0.5rem' }}>
				{post.subtitle} · by {post.author}
			</p>
			<p>{post.body}</p>
			<hr style={{ marginTop: '2rem', border: 'none', borderTop: '1px solid #eee' }} />
			<p style={{ fontSize: '0.85rem', color: '#666' }}>
				This page&apos;s <code>&lt;meta property=&quot;og:image&quot;&gt;</code> is set by{' '}
				<code>generateMetadata()</code> using <code>client.image()</code>. View source
				to inspect it.
			</p>
		</main>
	);
}
