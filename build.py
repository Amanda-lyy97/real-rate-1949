#!/usr/bin/env python3
from pathlib import Path
root=Path(__file__).parent
html=(root/'site.html').read_text()
css=(root/'styles.css').read_text()
app=(root/'app.js').read_text()
data=(root/'data.js').read_text()
data_json=data.strip()
if data_json.startswith('window.APP_DATA = '):
    data_json=data_json[len('window.APP_DATA = '):].rstrip(';\n')
html=html.replace('<link rel="stylesheet" href="styles.css">', '<style>\n'+css+'\n</style>')
html=html.replace('<script src="data.js"></script>\n<script src="app.js"></script>', '<script>window.APP_DATA = '+data_json+';</script>\n<script>\n'+app+'\n</script>')
(root/'index.html').write_text(html)
print('index.html', (root/'index.html').stat().st_size, 'bytes')
