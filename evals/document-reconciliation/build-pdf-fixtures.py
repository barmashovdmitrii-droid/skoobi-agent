"""Generate synthetic, four-page source PDFs; requires reportlab for authoring only."""
import os
import sys
from reportlab.pdfgen.canvas import Canvas
from reportlab.lib.pagesizes import A4

destination = sys.argv[1]
os.makedirs(destination, exist_ok=True)
for variant in ('good', 'page4-conflict', 'missing-date', 'wrong-total'):
    canvas = Canvas(os.path.join(destination, variant + '.pdf'), pagesize=A4,
                    invariant=1, pageCompression=1)
    canvas.setAuthor('Synthetic fixture')
    canvas.setTitle('Synthetic calculation')
    for page in range(1, 5):
        canvas.setFont('Helvetica-Bold', 18)
        canvas.drawString(48, 792, 'Synthetic calculation')
        canvas.setFont('Helvetica', 11)
        organization = 'Example Company B' if variant == 'page4-conflict' and page == 4 else 'Example Company A'
        lines = [f'Organization: {organization}', 'Person: Example Person', 'Document: DEMO-001']
        if variant != 'missing-date':
            lines.append('Date: 2026-01-02')
        lines += ['Currency: USD']
        if page == 1:
            lines += ['ITEM L01 | 3 | 0.335 | 1.01']
        if page == 4:
            lines += ['ITEM L02 | 2 | 1.005 | 2.01', 'Total: ' + ('3.00' if variant == 'wrong-total' else '3.02')]
        for i, line in enumerate(lines):
            canvas.drawString(48, 748 - i * 28, line)
        canvas.setFont('Helvetica', 9)
        canvas.drawString(48, 64, 'USD amounts rounded half up to 2 decimal places.')
        canvas.drawString(48, 48, f'Synthetic source / page {page} of 4')
        canvas.showPage()
    canvas.save()
