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
    
    // Navigation ბუტონების ფუნქციონალობა
    const navButtons = document.querySelectorAll('.nav-button');
    const documentationViewer = document.querySelector('.documentation-viewer');
    
    navButtons.forEach(button => {
        button.addEventListener('click', () => {
            // ყველა ბუტონიდან active კლასის წაშლა
            navButtons.forEach(btn => btn.classList.remove('active'));
            
            // დაკლიკულ ბუტონს active კლასის დამატება
            button.classList.add('active');
            
            // ტაბის მიხედვით ელემენტების ჩვენება/დამალვა
            const tabType = button.getAttribute('data-tab');
            
            if (tabType === 'exam') {
                // გამოცდის ტაბი - documentation-viewer უკან
                documentationViewer.classList.remove('active');
            } else if (tabType === 'documentation') {
                // დოკუმენტაციის ტაბი - documentation-viewer წინ
                documentationViewer.classList.add('active');
            }
        });
    });
});

