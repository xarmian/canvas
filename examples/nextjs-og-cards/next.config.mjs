/** @type {import('next').NextConfig} */
const nextConfig = {
	// Allow OG images from any Canvas instance. The example points at
	// `canvas.example.com` by default; set CANVAS_BASE_URL in
	// `.env.local` to your own instance and update this allowlist if
	// you want the index page to render the live thumbnails.
	images: {
		remotePatterns: [
			{ protocol: 'https', hostname: '**' },
			{ protocol: 'http', hostname: 'localhost' }
		]
	}
};

export default nextConfig;
