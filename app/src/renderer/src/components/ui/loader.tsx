// Adopted from prompt-kit's Loader (MIT, https://prompt-kit.com/c/loader.json),
// trimmed to the "dots" variant that ThinkingIndicator uses — the other eleven
// variants and their keyframes stayed behind (docs/04 §4 components log, M1.7).
// The bounce-dots keyframes live in assets/main.css: this is Tailwind v4, which
// ships no keyframes, so the registry's keyframes were carried over by hand.
import { cn } from '@/lib/utils'

export interface LoaderProps {
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

export function Loader({ size = 'md', className }: LoaderProps): React.JSX.Element {
  const dotSizes = {
    sm: 'h-1.5 w-1.5',
    md: 'h-2 w-2',
    lg: 'h-2.5 w-2.5'
  }

  const containerSizes = {
    sm: 'h-4',
    md: 'h-5',
    lg: 'h-6'
  }

  return (
    <div className={cn('flex items-center space-x-1', containerSizes[size], className)}>
      {[...Array(3)].map((_, i) => (
        <div
          key={i}
          className={cn(
            'bg-primary animate-[bounce-dots_1.4s_ease-in-out_infinite] rounded-full',
            dotSizes[size]
          )}
          style={{
            animationDelay: `${i * 160}ms`
          }}
        />
      ))}
      <span className="sr-only">Loading</span>
    </div>
  )
}
