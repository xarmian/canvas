import Link from 'next/link';
import { client } from '@/lib/client';
import { posts } from '@/lib/posts';

/**
 * Blog index — shows each post with its dynamically-built OG card
 * thumbnail. The `<img>` src is the URL produced by
 * `client.image()` directly; no proxy, no server-side fetch.
 */
export default function Home() {
	return (
		<main>
			<h1>Canvas OG cards demo</h1>
			<p>
				This Next.js example uses{' '}
				<a href="https://github.com/xarmian/canvas/tree/main/packages/sdk">
					<code>@canvas-images/sdk</code>
				</a>{' '}
				to build dynamic OG card URLs per blog post — no pre-rendered images.
			</p>
			<p>
				Each post page sets <code>metadata.openGraph.images</code> to a URL produced by{' '}
				<code>client.image(&apos;og-card&apos;, &#123; title, subtitle &#125;)</code>. The
				crawler that fetches that URL hits the Canvas Render API and gets the rendered PNG
				back.
			</p>
			<p>
				<strong>Setup:</strong> point <code>CANVAS_BASE_URL</code> at your own Canvas
				instance in <code>.env.local</code> and define a canvas with slug{' '}
				<code>og-card</code> that accepts <code>title</code> + <code>subtitle</code>{' '}
				params. See the <code>README.md</code> for full setup.
			</p>

			<h2>Posts</h2>
			<ul style={{ listStyle: 'none', padding: 0 }}>
				{posts.map((post) => {
					const ogUrl = client.image('og-card', {
						title: post.title,
						subtitle: post.subtitle
					});
					return (
						<li
							key={post.slug}
							style={{
								marginBottom: '2rem',
								paddingBottom: '2rem',
								borderBottom: '1px solid #eee'
							}}
						>
							<Link href={`/blog/${post.slug}`} style={{ color: '#0070f3' }}>
								<h3 style={{ margin: '0 0 0.5rem 0' }}>{post.title}</h3>
							</Link>
							<p style={{ margin: '0 0 1rem 0', color: '#666' }}>{post.subtitle}</p>
							<details>
								<summary style={{ cursor: 'pointer', color: '#666' }}>
									Built OG URL
								</summary>
								<pre
									style={{
										background: '#f6f8fa',
										padding: '0.75rem',
										borderRadius: '4px',
										overflow: 'auto',
										fontSize: '0.85rem'
									}}
								>
									{ogUrl}
								</pre>
							</details>
						</li>
					);
				})}
			</ul>
		</main>
	);
}
