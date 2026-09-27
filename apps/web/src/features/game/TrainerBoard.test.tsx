import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PromotionPicker, TrainerBoard } from './TrainerBoard.tsx';

describe('PromotionPicker', () => {
  it('offers four big piece buttons with Russian names and a way out', () => {
    const html = renderToStaticMarkup(<PromotionPicker color="b" onChoose={() => undefined} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('В кого превратить пешку?');
    for (const label of ['Ферзь', 'Ладья', 'Слон', 'Конь', 'Отмена']) expect(html).toContain(label);
    expect(html.match(/<button/g)).toHaveLength(5);
    expect(html.match(/<svg/g)).toHaveLength(4);
    expect(html).not.toMatch(/>[A-Za-z]{3,}</); // no English labels
  });
});

describe('TrainerBoard', () => {
  it('renders nothing but the measuring area before the first layout (no SSR size guess)', () => {
    const html = renderToStaticMarkup(
      <TrainerBoard
        fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        orientation="w"
        childColor="w"
        interactive
        lastMove={null}
        checkSquare={null}
        selected={null}
        legalTargets={[]}
        annotations={null}
        pendingPromotion={null}
        onSquareClick={() => undefined}
        onDragStart={() => undefined}
        onDrop={() => false}
        onPromotion={() => undefined}
      />,
    );
    expect(html).toMatch(/^<div class="[^"]*"><\/div>$/);
  });
});
