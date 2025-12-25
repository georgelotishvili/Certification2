// გამოცდის JavaScript ფაილი

document.addEventListener('DOMContentLoaded', () => {
    // Fullscreen-ზე გადასვლა
    if (window.electronAPI) {
        window.electronAPI.setFullscreen();
    }
    
    const finishButton = document.getElementById('finish-button');
    
    if (finishButton) {
        finishButton.addEventListener('click', () => {
            // Fullscreen-იდან გამოსვლა
            if (window.electronAPI) {
                window.electronAPI.exitFullscreen();
            }
            
            // მთავარ გვერდზე დაბრუნება
            setTimeout(() => {
                window.location.href = 'index.html';
            }, 100);
        });
    }
});

