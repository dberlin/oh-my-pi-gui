/**
 * Section component: a labeled section container with an uppercase heading.
 * Used in settings pages to group related configuration options.
 */

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="mb-5">
			<h3 className="mb-2 text-omp-xs font-semibold tracking-widest text-(--omp-dim) uppercase">{title}</h3>
			{children}
		</section>
	);
}
