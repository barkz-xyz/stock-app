const print = () => window.print()
document.getElementById('reprint').addEventListener('click', print)
window.addEventListener('load', print, { once: true })
